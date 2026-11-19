import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { addShot, moveShot, removeShot } from "../src/shared/storyboard";
import { addAsset, mergeAssets } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { editPrompt, findPrompt, promptInput, reviewPrompt } from "../src/shared/prompts";
import { addFrameCandidate, chooseFrame, hasCurrentConfirmation, invalidateChangedConfirmation } from "../src/shared/frames";
import type { PromptKind, TaskWorkspace } from "../src/shared/models";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dependency-sequence-")), path = join(directory, "workspace.sqlite");
  const database = new ApplicationDatabase(path);
  const store = new ReferenceImageStore(database, directory, async bytes => {
    const decoded = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
    return { png: decoded.data, width: decoded.info.width, height: decoded.info.height };
  });
  const options = { logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: directory,
    references: { async importForTask() { return null; }, isAvailable: (id: string) => store.isAvailable(id) } };
  const app = createApplicationServices({ database, ...options });
  const { tasks } = database.transaction(() => app.repository.createPlan({ title: "四镜头依赖", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" }));
  const id = tasks[0]!.id;
  const save = async (draft: TaskWorkspace) => {
    const task = app.repository.getTask(id);
    const workspace = invalidateChangedConfirmation(task.workspace, draft, "comic");
    const result = await app.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: { id, expectedRevision: task.revision, workspace } }, { trusted: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    return app.repository.getTask(id).workspace;
  };
  let w: TaskWorkspace = { ...tasks[0]!.workspace, script: "四个独立镜头，首尾保持，中间调整。" };
  for (let i = 0; i < 4; i++) {
    const shot = randomUUID(), asset = randomUUID();
    w = addShot(w, shot); w = addAsset(w, asset, "person");
    w.shots[i] = { ...w.shots[i]!, title: `镜头${i + 1}`, description: `画面${i + 1}` };
    w.assets[i] = { ...w.assets[i]!, name: `人物${i + 1}`, description: `设定${i + 1}` };
    w = setAssetLink(w, asset, shot, true);
  }
  w = addAsset(w, randomUUID(), "prop");
  for (const shot of w.shots) w = editPrompt(w, "comic", "shot", shot.id, `保留文本:${shot.title}`);
  for (const kind of ["video", "firstFrame", "lastFrame"] as const) w = editPrompt(w, "comic", kind, null, `保留文本:${kind}`);
  w = await save(w);
  const file = join(directory, "synthetic.png");
  writeFileSync(file, await sharp({ create: { width: 16, height: 12, channels: 3, background: "#123456" } }).png().toBuffer());
  const image = await store.importFile(id, file);
  for (const slot of ["first", "last"] as const) {
    const candidate = randomUUID(); w = addFrameCandidate(w, "comic", slot, image.id, candidate, new Date().toISOString()); w = chooseFrame(w, slot, candidate);
  }
  w = await save(w);
  assert.equal((await app.router.dispatch({ requestId: randomUUID(), command: "tasks.confirmFrames", input: { id, expectedRevision: app.repository.getTask(id).revision } }, { trusted: true })).ok, true);
  w = app.repository.getTask(id).workspace; assert.equal(hasCurrentConfirmation(w, "comic"), true);
  const histories = () => database.connection.prepare("SELECT * FROM prompt_history WHERE task_id=? ORDER BY kind,shot_key,version").all(id);
  const reopen = (expected: TaskWorkspace) => {
    const rows = histories(); database.close();
    const db = new ApplicationDatabase(path);
    try {
      const reopened = createApplicationServices({ database: db, ...options }).repository.getTask(id);
      assert.deepEqual(reopened.workspace, expected);
      assert.deepEqual(db.connection.prepare("SELECT * FROM prompt_history WHERE task_id=? ORDER BY kind,shot_key,version").all(id), rows);
    } finally { db.close(); }
  };
  return { database, app, id, w, save, histories, reopen, close() { if (database.connection.isOpen) database.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const stale = (w: TaskWorkspace, kind: PromptKind, id: string | null = null) => findPrompt(w, kind, id)!.inputSnapshot !== promptInput(w, "comic", kind, id);

test("interior reorder then tail deletion preserves saved text/history and candidate provenance while invalidating ordered dependencies", async () => {
  const f = await fixture(); try {
    const original = f.w, [a, b, c, d] = original.shots.map(s => s.id), history = f.histories();
    let w = await f.save(moveShot(original, c!, -1));
    assert.deepEqual(w.shots.map(s => s.id), [a, c, b, d]);
    assert.deepEqual(w.prompts, original.prompts); assert.deepEqual(f.histories(), history);
    for (const id of [a!, d!]) assert.equal(stale(w, "shot", id), false);
    for (const id of [b!, c!]) assert.equal(stale(w, "shot", id), true);
    assert.equal(stale(w, "video"), true); assert.equal(stale(w, "firstFrame"), false); assert.equal(stale(w, "lastFrame"), false);
    assert.equal(hasCurrentConfirmation(w, "comic"), false); assert.equal(w.frames!.confirmation!.invalidated, true);
    assert.deepEqual(w.frames!.candidates, original.frames!.candidates);
    // Explicit local review appends versions, but never rewrites the original snapshots.
    for (const id of [b!, c!]) w = reviewPrompt(w, "comic", "shot", id);
    w = reviewPrompt(w, "comic", "video", null); w = await f.save(w);
    assert.equal(findPrompt(w, "shot", b!)!.version, 2);
    const beforeDelete = f.histories();
    assert.deepEqual(beforeDelete.filter(row => row.version === 1), history);
    w = await f.save(removeShot(w, d!));
    assert.equal(w.assetLinks.some(link => link.shotId === d), false); assert.equal(w.prompts!.some(p => p.shotId === d), false);
    assert.equal(stale(w, "firstFrame"), false); assert.equal(stale(w, "lastFrame"), true); assert.equal(stale(w, "video"), true);
    assert.deepEqual(f.histories(), beforeDelete); assert.deepEqual(w.frames!.candidates, original.frames!.candidates);
    const deletedHistory = f.app.repository.getPromptHistory({ taskId: f.id, kind: "shot", shotId: d!, version: 1 });
    assert.equal(deletedHistory.text, findPrompt(original, "shot", d!)!.text);
    assert.equal(deletedHistory.inputSnapshot, findPrompt(original, "shot", d!)!.inputSnapshot);
    f.reopen(w);
  } finally { f.close(); }
});

test("rename and same-type asset merge affect only linked shot inputs and applicable endpoint without rewriting manual versions", async () => {
  const f = await fixture(); try {
    const original = f.w, history = f.histories(), [a, b, c, d] = original.shots.map(s => s.id);
    let w = await f.save({ ...original, assets: original.assets.map((asset, i) => i === 1 ? { ...asset, name: "人物二改名" } : asset) });
    assert.equal(stale(w, "shot", b!), true);
    for (const id of [a!, c!, d!]) assert.equal(stale(w, "shot", id), false);
    assert.equal(stale(w, "video"), true); assert.equal(stale(w, "firstFrame"), false); assert.equal(stale(w, "lastFrame"), false);
    const source = w.assets[1]!, target = w.assets[0]!;
    w = await f.save(mergeAssets(w, source.id, target.id, { name: "source", description: "target", referenceImageId: "target" }));
    assert.equal(w.assets.some(asset => asset.id === source.id), false);
    assert.deepEqual(w.assets.find(asset => asset.id === target.id)!.position, target.position);
    assert.equal(w.assetLinks.filter(link => link.assetId === target.id).length, 2);
    assert.equal(new Set(w.assetLinks.map(link => `${link.shotId}:${link.assetId}`)).size, w.assetLinks.length);
    assert.equal(w.assetLinks.some(link => link.assetId === source.id), false);
    for (const id of [a!, b!]) assert.equal(stale(w, "shot", id), true);
    for (const id of [c!, d!]) assert.equal(stale(w, "shot", id), false);
    assert.equal(stale(w, "firstFrame"), true); assert.equal(stale(w, "lastFrame"), false);
    assert.equal(w.frames!.confirmation!.invalidated, true);
    assert.deepEqual(w.prompts, original.prompts); assert.deepEqual(f.histories(), history);
    assert.deepEqual(w.frames!.candidates, original.frames!.candidates); f.reopen(w);
  } finally { f.close(); }
});

test("layout and unlinked asset edits persist without invalidating prompts, candidate sources or a confirmed frame pair", async () => {
  const f = await fixture(); try {
    const original = f.w, history = f.histories();
    const w = await f.save({ ...original, viewport: { x: 44, y: 55, zoom: 0.8 }, scriptPosition: { x: 333, y: 444 },
      shots: original.shots.map(s => ({ ...s, position: { x: s.position.x + 111, y: s.position.y + 222 } })),
      assets: original.assets.map((a, i) => ({ ...a, position: { x: 1000, y: 200 + i * 300 }, ...(i === 4 ? { name: "未引用道具重命名", description: "不进入任何镜头输入" } : {}) })) });
    for (const p of w.prompts!) assert.equal(stale(w, p.kind, p.shotId), false);
    assert.deepEqual(w.prompts, original.prompts); assert.deepEqual(w.frames, original.frames); assert.deepEqual(f.histories(), history);
    assert.equal(hasCurrentConfirmation(w, "comic"), true); assert.equal(w.assets[4]!.version, 2);
    assert.deepEqual(w.assets.slice(0, 4).map(a => a.version), original.assets.slice(0, 4).map(a => a.version)); f.reopen(w);
  } finally { f.close(); }
});
