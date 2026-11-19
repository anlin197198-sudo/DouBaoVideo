import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { addShot, moveShot, removeShot } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { editPrompt, findPrompt, promptInput, reviewPrompt } from "../src/shared/prompts";
import type { PromptKind, TaskWorkspace } from "../src/shared/models";

function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "test" });
  return { database, ...services };
}
function setup(f: ReturnType<typeof fixture>) {
  const { tasks } = f.database.transaction(() => f.repository.createPlan({ title: "提示词验收", style: "comic",
    startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" }));
  let w = addShot(addShot({ ...tasks[0]!.workspace, script: "双镜头故事" }, randomUUID()), randomUUID());
  w = addAsset(addAsset(w, randomUUID(), "person"), randomUUID(), "prop");
  w = setAssetLink(w, w.assets[1]!.id, w.shots[1]!.id, true);
  for (const shot of w.shots) w = editPrompt(w, "comic", "shot", shot.id, shot.title);
  for (const kind of ["video", "firstFrame", "lastFrame"] as const) w = editPrompt(w, "comic", kind, null, kind);
  return { tasks, w };
}
const stale = (w: TaskWorkspace, kind: PromptKind, shotId: string | null = null) =>
  findPrompt(w, kind, shotId)?.inputSnapshot !== promptInput(w, "comic", kind, shotId);
async function save(f: ReturnType<typeof fixture>, id: string, workspace: TaskWorkspace, revision = f.repository.getTask(id).revision) {
  return f.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: { id, expectedRevision: revision, workspace } }, { trusted: true });
}

test("prompt dependencies invalidate only referenced shots and affected frame; preserve text and explicit local review", () => {
  const f = fixture();
  try {
    const { w } = setup(f), one = w.shots[0]!.id, two = w.shots[1]!.id;
    const changed = { ...w, assets: w.assets.map((asset, i) => i === 1 ? { ...asset, description: "新道具" } : asset) };
    assert.equal(stale(changed, "shot", one), false);
    assert.equal(stale(changed, "shot", two), true);
    assert.equal(stale(changed, "video"), true);
    assert.equal(stale(changed, "firstFrame"), false);
    assert.equal(stale(changed, "lastFrame"), true);
    const reviewed = reviewPrompt(changed, "comic", "shot", two);
    assert.equal(stale(reviewed, "shot", two), false);
    assert.equal(stale(reviewed, "video"), true);
    assert.equal(findPrompt(reviewed, "shot", two)?.text, findPrompt(w, "shot", two)?.text);
    const edited = editPrompt(changed, "comic", "shot", two, "保留的人工修订");
    assert.equal(stale(edited, "shot", two), true);
    const unrelated = { ...w, assets: w.assets.map((asset, i) => i === 0 ? { ...asset, name: "未引用资产" } : asset) };
    assert.equal(stale(unrelated, "video"), false);
    const layout = { ...w, shots: w.shots.map(s => ({ ...s, position: { x: 999, y: 888 }, needsReview: true })) };
    assert.equal(stale(layout, "video"), false);
    assert.equal(stale(editPrompt(w, "comic", "shot", one, "新镜头词"), "video"), true);
  } finally { f.database.close(); }
});

test("style inheritance, override, notes, ordering, missing and single shots produce distinct static frame inputs", () => {
  const f = fixture();
  try {
    const { w } = setup(f);
    assert.match(promptInput(w, "comic", "video", null), /漫剧/);
    const override = { ...w, promptSettings: { style: "realistic" as const, notes: "暖色" } };
    assert.match(promptInput(override, "comic", "video", null), /偏真人/);
    assert.match(promptInput(override, "comic", "firstFrame", null), /暖色/);
    assert.equal(stale(override, "lastFrame"), true);
    const moved = moveShot(w, w.shots[1]!.id, -1);
    assert.equal(stale(moved, "firstFrame"), true);
    const single = removeShot(w, w.shots[0]!.id);
    assert.equal(single.prompts!.some(p => p.shotId === w.shots[0]!.id), false);
    const first = JSON.parse(promptInput(single, "comic", "firstFrame", null));
    const last = JSON.parse(promptInput(single, "comic", "lastFrame", null));
    assert.deepEqual(first.shots, last.shots);
    assert.notEqual(first.purpose, last.purpose);
    const empty = removeShot(single, single.shots[0]!.id);
    assert.deepEqual(JSON.parse(promptInput(empty, "comic", "video", null)).shots, []);
    assert.throws(() => promptInput(empty, "comic", "shot", randomUUID()));
  } finally { f.database.close(); }
});

test("prompt versions and settings persist across restart; duplicate, dangling and stale writes rejected atomically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-prompts-"));
  const path = join(directory, "workspace.sqlite");
  let f = fixture(path);
  try {
    const { tasks, w } = setup(f), id = tasks[0]!.id;
    w.promptSettings = { style: null, notes: "手绘风格" };
    assert.equal((await save(f, id, w)).ok, true);
    f.database.close(); f = fixture(path);
    let restored = f.repository.getTask(id);
    assert.deepEqual(restored.workspace.prompts, w.prompts);
    assert.deepEqual(restored.workspace.promptSettings, w.promptSettings);
    assert.equal(f.repository.getTask(tasks[1]!.id).workspace.prompts, undefined);
    assert.equal((await save(f, id, restored.workspace)).ok, true);
    assert.equal(findPrompt(f.repository.getTask(id).workspace, "video", null)?.version, 1);
    const edited = editPrompt(restored.workspace, "comic", "video", null, "人工更新");
    assert.equal((await save(f, id, edited)).ok, true);
    assert.equal(findPrompt(f.repository.getTask(id).workspace, "video", null)?.version, 2);
    assert.equal((await save(f, id, w, restored.revision)).ok, false);
    restored = f.repository.getTask(id);
    const duplicate = { ...restored.workspace, prompts: [...restored.workspace.prompts!, restored.workspace.prompts![0]!] };
    assert.equal((await save(f, id, duplicate)).ok, false);
    const dangling = { ...restored.workspace, prompts: [{ ...restored.workspace.prompts![0]!, kind: "shot" as const, shotId: randomUUID() }] };
    assert.equal((await save(f, id, dangling)).ok, false);
    assert.deepEqual(f.repository.getTask(id), restored);
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
