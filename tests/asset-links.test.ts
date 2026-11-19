import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { addAsset, mergeAssets } from "../src/shared/assets";
import { addShot, editScript, moveShot, removeShot } from "../src/shared/storyboard";
import { connectionError, removeAsset, setAssetLink } from "../src/shared/asset-links";
import type { TaskWorkspace } from "../src/shared/models";

function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} },
    version: "test", dataDirectory: "test" });
  return { database, ...services };
}
function setup(f: ReturnType<typeof fixture>) {
  const tasks = f.database.transaction(() => f.repository.createPlan({
    title: "关联验收", style: "realistic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00",
  })).tasks;
  let w = editScript(tasks[0]!.workspace, "两镜头共用主角，仅第二镜头持剑。");
  w = addShot(addShot(w, randomUUID()), randomUUID());
  w = addAsset(addAsset(w, randomUUID(), "person"), randomUUID(), "prop");
  return { tasks, w, person: w.assets[0]!.id, prop: w.assets[1]!.id, one: w.shots[0]!.id, two: w.shots[1]!.id };
}
async function save(f: ReturnType<typeof fixture>, id: string, workspace: TaskWorkspace, revision?: number) {
  return f.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: {
    id, expectedRevision: revision ?? f.repository.getTask(id).revision, workspace,
  } }, { trusted: true });
}

test("checkbox and canvas share duplicate-safe links; unlink only affects the selected pair", () => {
  const f = fixture();
  try {
    const { w, person, prop, one, two } = setup(f);
    let next = setAssetLink(setAssetLink(setAssetLink(w, person, one, true), person, two, true), prop, two, true);
    assert.equal(next.assetLinks.length, 3);
    assert.equal(setAssetLink(next, person, one, true), next);
    next = setAssetLink(next, prop, two, false);
    assert.deepEqual(next.assetLinks, [{ assetId: person, shotId: one }, { assetId: person, shotId: two }]);
    assert.equal(setAssetLink(next, prop, two, false), next);
    assert.equal(connectionError(next, prop, two), null);
    for (const [source, target] of [[one, person], [person, person], ["script", one], [randomUUID(), two], [person, randomUUID()]])
      assert.throws(() => setAssetLink(next, source!, target!, true));
  } finally { f.database.close(); }
});

test("relations restore after database restart, preserve task isolation and reject stale or dangling writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-links-"));
  const path = join(directory, "workspace.sqlite");
  let f = fixture(path);
  try {
    const { tasks, w, person, prop, one, two } = setup(f), id = tasks[0]!.id;
    const linked = setAssetLink(setAssetLink(setAssetLink(w, person, one, true), person, two, true), prop, two, true);
    assert.equal((await save(f, id, linked)).ok, true);
    f.database.close(); f = fixture(path);
    let restored = f.repository.getTask(id);
    assert.deepEqual(restored.workspace.assetLinks, linked.assetLinks);
    assert.deepEqual(f.repository.getTask(tasks[1]!.id).workspace.assetLinks, []);
    const removed = setAssetLink(restored.workspace, prop, two, false);
    assert.equal((await save(f, id, removed)).ok, true);
    assert.equal((await save(f, id, linked, restored.revision)).ok, false);
    restored = f.repository.getTask(id);
    const bad = { ...restored.workspace, assetLinks: [{ assetId: randomUUID(), shotId: one }] };
    assert.equal((await save(f, id, bad)).ok, false);
    assert.deepEqual(f.repository.getTask(id).workspace.assetLinks, removed.assetLinks);
    const duplicates = { ...removed, assetLinks: [...removed.assetLinks, ...removed.assetLinks] };
    assert.equal((await save(f, id, duplicates)).ok, true);
    assert.equal(f.repository.getTask(id).workspace.assetLinks.length, 2);
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("delete and merge clean relations, redirect source references and preserve other shots", () => {
  const f = fixture();
  try {
    const { w, person, prop, one, two } = setup(f);
    const duplicate = randomUUID();
    let linked = addAsset(w, duplicate, "person");
    linked = setAssetLink(setAssetLink(setAssetLink(setAssetLink(linked, person, one, true), duplicate, one, true), duplicate, two, true), prop, two, true);
    const merged = mergeAssets(linked, duplicate, person, { name: "target", description: "target", referenceImageId: "target" });
    assert.deepEqual(merged.assetLinks, [{ assetId: person, shotId: one }, { assetId: person, shotId: two }, { assetId: prop, shotId: two }]);
    assert.equal(merged.assets.some(asset => asset.id === duplicate), false);
    assert.deepEqual(removeShot(merged, two).assetLinks, [{ assetId: person, shotId: one }]);
    assert.deepEqual(removeAsset(merged, prop).assetLinks, merged.assetLinks.slice(0, 2));
    assert.deepEqual(moveShot(merged, two, -1).assetLinks, merged.assetLinks);
  } finally { f.database.close(); }
});

test("asset edits mark only referencing shots for review; layout changes do not invalidate content", async () => {
  const f = fixture();
  try {
    const { tasks, w, person, prop, one, two } = setup(f), id = tasks[0]!.id;
    let linked = setAssetLink(setAssetLink(setAssetLink(w, person, one, true), person, two, true), prop, two, true);
    await save(f, id, linked);
    linked = f.repository.getTask(id).workspace;
    linked = { ...linked, shots: linked.shots.map(shot => ({ ...shot, assetsNeedReview: false })) };
    await save(f, id, linked);
    linked = f.repository.getTask(id).workspace;
    linked = { ...linked, assets: linked.assets.map(asset => asset.id === prop ? { ...asset, description: "青色竹剑" } : asset) };
    await save(f, id, linked);
    const saved = f.repository.getTask(id).workspace;
    assert.equal(saved.shots[0]!.assetsNeedReview, false);
    assert.equal(saved.shots[1]!.assetsNeedReview, true);
    linked = { ...saved, shots: saved.shots.map(shot => ({ ...shot, assetsNeedReview: false })),
      assets: saved.assets.map(asset => ({ ...asset, position: { x: 100, y: 200 } })) };
    await save(f, id, linked);
    assert.ok(f.repository.getTask(id).workspace.shots.every(shot => !shot.assetsNeedReview));
  } finally { f.database.close(); }
});
