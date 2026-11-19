import { WorkspaceAutosave } from "../src/shared/workspace-autosave";
import { verifiedMediaResponse } from "../src/main/application/verified-media-response";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { createApplicationServices } from "../src/main/application/services";
import { addFrameCandidate, chooseFrame, confirmationBlocker, confirmationIssue, currentFrame, frameState, hasCurrentConfirmation } from "../src/shared/frames";
import { editPrompt, reviewPrompt, findPrompt } from "../src/shared/prompts";
import type { TaskWorkspace } from "../src/shared/models";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "doubao-frames-")), path = join(directory, "workspace.sqlite");
  const database = new ApplicationDatabase(path);
  const store = new ReferenceImageStore(database, directory, async bytes => {
    const result = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
    return { png: result.data, width: result.info.width, height: result.info.height };
  });
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: directory,
    references: { async importForTask() { return null; }, isAvailable: id => store.isAvailable(id) } });
  const { tasks } = database.transaction(() => services.repository.createPlan({ title: "首尾图测试", style: "realistic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" }));
  const file = join(directory, "source.png");
  writeFileSync(file, await sharp({ create: { width: 20, height: 30, channels: 3, background: "#7f8a9b" } }).png().toBuffer());
  const image = await store.importFile(tasks[0]!.id, file);
  let workspace = editPrompt(tasks[0]!.workspace, "realistic", "video", null, "镜头缓慢推进。");
  for (const slot of ["first", "last"] as const) {
    const id = randomUUID();
    workspace = addFrameCandidate(workspace, "realistic", slot, image.id, id, new Date().toISOString());
    workspace = chooseFrame(workspace, slot, id);
  }
  return { directory, path, database, store, ...services, tasks, workspace, file, image,
    close() { if (database.connection.isOpen) database.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function save(f: Awaited<ReturnType<typeof fixture>>, workspace: TaskWorkspace) {
  const task = f.repository.getTask(f.tasks[0]!.id);
  return f.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: { id: task.id, expectedRevision: task.revision, workspace } }, { trusted: true });
}
async function confirm(f: Awaited<ReturnType<typeof fixture>>, requestId = randomUUID()) {
  const task = f.repository.getTask(f.tasks[0]!.id);
  return f.router.dispatch({ requestId, command: "tasks.confirmFrames", input: { id: task.id, expectedRevision: task.revision } }, { trusted: true });
}

test("two static imported candidates stay independent, archive survives source rename and database reopen", async () => {
  const f = await fixture();
  try {
    const last = currentFrame(f.workspace, "last")!.id;
    const candidateId = randomUUID();
    let w = addFrameCandidate(f.workspace, "realistic", "first", f.image.id, candidateId, new Date().toISOString());
    const draft = editPrompt(w, "realistic", "firstFrame", null, "尚未保存的首帧提示词");
    const draftCandidate = addFrameCandidate(draft, "realistic", "first", f.image.id, randomUUID(), new Date().toISOString(), false);
    assert.equal(draftCandidate.frames!.candidates.at(-1)!.promptVersion, null);
    assert.equal(draftCandidate.frames!.candidates.at(-1)!.promptText, "尚未保存的首帧提示词");
    assert.equal(currentFrame(w, "first")!.id, currentFrame(f.workspace, "first")!.id);
    w = chooseFrame(w, "first", candidateId);
    assert.equal(currentFrame(w, "last")!.id, last);
    assert.throws(() => chooseFrame(w, "last", candidateId));
    assert.equal((await save(f, w)).ok, true);
    renameSync(f.file, join(f.directory, "renamed.png"));
    assert.ok(f.store.pathFor(f.image.id));
    const second = new ApplicationDatabase(f.path);
    try {
      const services = createApplicationServices({ database: second, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: f.directory });
      assert.deepEqual(services.repository.getTask(f.tasks[0]!.id).workspace.frames, w.frames);
      assert.equal(services.repository.getTask(f.tasks[1]!.id).workspace.frames, undefined);
    } finally { second.close(); }
  } finally { f.close(); }
});

test("explicit confirmation persists and layout preserves it; changes invalidate irreversibly until reconfirmed", async () => {
  const f = await fixture();
  try {
    assert.equal((await save(f, f.workspace)).ok, true);
    assert.equal((await confirm(f)).ok, true);
    let task = f.repository.getTask(f.tasks[0]!.id);
    assert.equal(hasCurrentConfirmation(task.workspace, "realistic"), true);
    const confirmedAt = task.workspace.frames!.confirmation!.confirmedAt;
    const reopened = new ApplicationDatabase(f.path);
    try {
      const reader = createApplicationServices({ database: reopened, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: f.directory });
      assert.equal(hasCurrentConfirmation(reader.repository.getTask(task.id).workspace, "realistic"), true);
    } finally { reopened.close(); }
    assert.equal((await save(f, { ...task.workspace, viewport: { x: 200, y: 500, zoom: 2 } })).ok, true);
    task = f.repository.getTask(task.id);
    assert.equal(hasCurrentConfirmation(task.workspace, "realistic"), true);
    const changed = { ...task.workspace, frames: { ...frameState(task.workspace), parameters: { aspectRatio: "9:16" as const, durationSeconds: 10 as const } } };
    assert.equal((await save(f, changed)).ok, true);
    task = f.repository.getTask(task.id);
    assert.equal(hasCurrentConfirmation(task.workspace, "realistic"), false);
    assert.equal(task.workspace.frames!.confirmation!.confirmedAt, confirmedAt);
    const reverted = { ...task.workspace, frames: { ...task.workspace.frames!, parameters: { aspectRatio: "16:9" as const, durationSeconds: 5 as const } } };
    assert.equal((await save(f, reverted)).ok, true);
    assert.equal(hasCurrentConfirmation(f.repository.getTask(task.id).workspace, "realistic"), false);
    assert.equal((await confirm(f)).ok, true);
    task = f.repository.getTask(task.id);
    const edited = editPrompt(task.workspace, "realistic", "video", null, "新视频描述");
    assert.equal((await save(f, edited)).ok, true);
    assert.equal(hasCurrentConfirmation(f.repository.getTask(task.id).workspace, "realistic"), false);
  } finally { f.close(); }
});

test("confirmation rejects missing images, stale input/revision and forged workspace confirmation; source immutable and task-scoped", async () => {
  const f = await fixture();
  try {
    assert.equal((await confirm(f)).ok, false);
    const forged = structuredClone(f.workspace);
    forged.frames!.confirmation = { inputSnapshot: "forged", confirmedAt: new Date().toISOString(), invalidated: false };
    assert.equal((await save(f, forged)).ok, true);
    assert.equal(f.repository.getTask(f.tasks[0]!.id).workspace.frames!.confirmation, null);
    const changedSource = structuredClone(f.workspace);
    changedSource.frames!.candidates[0]!.promptText = "伪造来源";
    assert.equal((await save(f, changedSource)).ok, false);
    const wrongTask = await f.store.importFile(f.tasks[1]!.id, f.file);
    let bad = addFrameCandidate(f.workspace, "realistic", "first", wrongTask.id, randomUUID(), new Date().toISOString());
    assert.equal((await save(f, bad)).ok, false);
    assert.equal((await save(f, { ...f.workspace, script: "已变更" })).ok, true);
    assert.equal((await confirm(f)).ok, false);
    let staleFrame = editPrompt(f.workspace, "realistic", "firstFrame", null, "旧首帧词");
    staleFrame = { ...staleFrame, promptSettings: { style: "comic", notes: "" } };
    staleFrame = reviewPrompt(staleFrame, "realistic", "video", null);
    assert.equal((await save(f, staleFrame)).ok, true);
    assert.equal((await confirm(f)).ok, false); // Reviewing only video must not bypass an existing stale image prompt.
    assert.equal((await save(f, f.workspace)).ok, true);
    const before = f.repository.getTask(f.tasks[0]!.id);
    assert.equal((await confirm(f)).ok, true);
    assert.equal((await f.router.dispatch({ requestId: randomUUID(), command: "tasks.confirmFrames", input: {
      id: before.id, expectedRevision: before.revision } }, { trusted: true })).ok, false);
    const archived = f.store.pathFor(f.image.id)!, bytes = readFileSync(archived);
    writeFileSync(archived, bytes.subarray(0, 40));
    assert.equal((await confirm(f)).ok, false); // Valid PNG magic is not proof of readable archived pixels.
    writeFileSync(archived, bytes);
    renameSync(archived, join(f.directory, "missing.png"));
    assert.equal((await confirm(f)).ok, false);
  } finally { f.close(); }
});


test("review issue offers exact prompt navigation without changing confirmation rules or source data", async () => {
  const f = await fixture();
  try {
    const snapshot = JSON.stringify(f.workspace);
    assert.equal(confirmationIssue(f.workspace, "realistic"), null); // manual imports need no image prompts
    const missingFrame = chooseFrame(f.workspace, "last", null);
    assert.equal(confirmationIssue(missingFrame, "realistic")!.promptKind, undefined);
    const missingVideo = { ...f.workspace, prompts: [] };
    assert.equal(confirmationIssue(missingVideo, "realistic")!.promptKind, "video");
    assert.match(confirmationIssue(missingVideo, "realistic")!.actionLabel!, /填写/);
    let w = editPrompt(f.workspace, "realistic", "firstFrame", null, "开场");
    w = editPrompt(w, "realistic", "lastFrame", null, "结束");
    w = { ...w, script: w.script + " changed" };
    assert.equal(confirmationIssue(w, "realistic")!.promptKind, "video");
    w = reviewPrompt(w, "realistic", "video", null);
    assert.equal(confirmationIssue(w, "realistic")!.promptKind, "firstFrame");
    w = reviewPrompt(w, "realistic", "firstFrame", null);
    assert.equal(confirmationIssue(w, "realistic")!.promptKind, "lastFrame");
    assert.equal(confirmationBlocker(w, "realistic"), confirmationIssue(w, "realistic")!.message);
    w = reviewPrompt(w, "realistic", "lastFrame", null);
    assert.equal(confirmationIssue(w, "realistic"), null);
    assert.equal(JSON.stringify(f.workspace), snapshot);
  } finally { f.close(); }
});

async function distinctImage(f: Awaited<ReturnType<typeof fixture>>, name: string, background: string, width: number, height: number) {
  const file = join(f.directory, name);
  writeFileSync(file, await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer());
  return f.store.importFile(f.tasks[0]!.id, file);
}
function taskState(f: Awaited<ReturnType<typeof fixture>>) {
  return { task: f.repository.getTask(f.tasks[0]!.id), receipts: f.database.connection.prepare("SELECT * FROM command_receipts ORDER BY request_id").all() };
}
function verifyClosedReopen(f: Awaited<ReturnType<typeof fixture>>, expected: TaskWorkspace) {
  f.database.close();
  const database = new ApplicationDatabase(f.path);
  try {
    const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: f.directory });
    assert.deepEqual(services.repository.getTask(f.tasks[0]!.id).workspace, expected);
    const store = new ReferenceImageStore(database, f.directory, async bytes => {
      const image = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
      return { png: image.data, width: image.info.width, height: image.info.height };
    });
    for (const slot of ["first", "last"] as const) assert.equal(store.isAvailable(currentFrame(expected, slot)!.imageId), true);
  } finally { database.close(); }
}

test("distinct first/last images reject swapped slots, replacing and reverting one selection stays invalid until explicit confirmation and reopen", async () => {
  const f = await fixture(); try {
    const lastImage = await distinctImage(f, "last-blue.png", "#0000ff", 60, 20);
    const replacement = await distinctImage(f, "first-red.png", "#ff0000", 40, 40);
    let w = addFrameCandidate(f.workspace, "realistic", "last", lastImage.id, randomUUID(), new Date().toISOString());
    w = chooseFrame(w, "last", w.frames!.candidates.at(-1)!.id);
    assert.equal((await save(f, w)).ok, true); assert.equal((await confirm(f)).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    const first = currentFrame(w, "first")!, last = currentFrame(w, "last")!, candidates = structuredClone(w.frames!.candidates);
    const input = JSON.parse(w.frames!.confirmation!.inputSnapshot);
    assert.equal(input.first.imageId, f.image.id); assert.equal(input.last.imageId, lastImage.id);
    assert.notEqual(input.first.imageId, input.last.imageId);
    const invalid = { ...w, frames: { ...w.frames!, firstId: last.id, lastId: first.id } }, before = taskState(f);
    const rejected = await save(f, invalid); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "INVALID_INPUT");
    assert.deepEqual(taskState(f), before);
    w = addFrameCandidate(w, "realistic", "first", replacement.id, randomUUID(), new Date().toISOString());
    w = chooseFrame(w, "first", w.frames!.candidates.at(-1)!.id);
    assert.equal((await save(f, w)).ok, true); w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(hasCurrentConfirmation(w, "realistic"), false); assert.deepEqual(currentFrame(w, "last"), last);
    assert.equal((await save(f, chooseFrame(w, "first", first.id))).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(hasCurrentConfirmation(w, "realistic"), false); assert.deepEqual(w.frames!.candidates.slice(0, candidates.length), candidates);
    const requestId = randomUUID(), task = f.repository.getTask(f.tasks[0]!.id);
    const request = { requestId, command: "tasks.confirmFrames", input: { id: task.id, expectedRevision: task.revision } };
    const result = await f.router.dispatch(request, { trusted: true }); assert.equal(result.ok, true);
    const confirmed = taskState(f); assert.deepEqual(await f.router.dispatch(request, { trusted: true }), result); assert.deepEqual(taskState(f), confirmed);
    assert.equal(hasCurrentConfirmation(confirmed.task.workspace, "realistic"), true); verifyClosedReopen(f, confirmed.task.workspace);
  } finally { f.close(); }
});

test("decodable archive replacement and truncated pixels reject reconfirmation atomically; reimport repairs exact original and a failed request can retry", async () => {
  const f = await fixture(); try {
    const lastImage = await distinctImage(f, "tail.png", "#009900", 80, 45);
    let w = addFrameCandidate(f.workspace, "realistic", "last", lastImage.id, randomUUID(), new Date().toISOString());
    w = chooseFrame(w, "last", w.frames!.candidates.at(-1)!.id);
    assert.equal((await save(f, w)).ok, true); assert.equal((await confirm(f)).ok, true);
    const before = taskState(f), archived = f.store.pathFor(lastImage.id)!, bytes = readFileSync(archived);
    const request = { requestId: randomUUID(), command: "tasks.confirmFrames", input: { id: before.task.id, expectedRevision: before.task.revision } };
    for (const corruption of [await sharp({ create: { width: 80, height: 45, channels: 3, background: "#ff00ff" } }).png().toBuffer(), bytes.subarray(0, 40)]) {
      writeFileSync(archived, corruption);
      assert.equal(f.store.isAvailable(lastImage.id), false);
      const result = await f.router.dispatch(request, { trusted: true }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "STORAGE_ERROR");
      assert.deepEqual(taskState(f), before); // Failed fresh confirmation never rewrites old audit evidence or records success.
    }
    const repaired = await f.store.importFile(f.tasks[0]!.id, join(f.directory, "tail.png"));
    assert.equal(repaired.id, lastImage.id); assert.deepEqual(readFileSync(archived), bytes);
    assert.equal((await f.router.dispatch(request, { trusted: true })).ok, true);
    const after = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.deepEqual(after.frames!.candidates, before.task.workspace.frames!.candidates);
    assert.equal(hasCurrentConfirmation(after, "realistic"), true); verifyClosedReopen(f, after);
  } finally { f.close(); }
});

test("stale video/first/last dependencies require separate review; failed confirmations add no receipts and preserve source/history through reopen", async () => {
  const f = await fixture(); try {
    let w = f.workspace;
    for (const kind of ["firstFrame", "lastFrame"] as const) w = editPrompt(w, "realistic", kind, null, `${kind}原文`);
    assert.equal((await save(f, w)).ok, true); assert.equal((await confirm(f)).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    const candidates = structuredClone(w.frames!.candidates);
    const histories = f.database.connection.prepare("SELECT * FROM prompt_history ORDER BY kind,shot_key,version").all();
    assert.equal((await save(f, { ...w, script: "新剧本影响各类提示词" })).ok, true);
    for (const kind of ["video", "firstFrame", "lastFrame"] as const) {
      w = f.repository.getTask(f.tasks[0]!.id).workspace;
      assert.equal(confirmationIssue(w, "realistic")!.promptKind, kind);
      const before = taskState(f); assert.equal((await confirm(f)).ok, false); assert.deepEqual(taskState(f), before);
      assert.equal((await save(f, reviewPrompt(w, "realistic", kind, null))).ok, true);
    }
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(confirmationIssue(w, "realistic"), null); assert.equal(hasCurrentConfirmation(w, "realistic"), false);
    assert.deepEqual(w.frames!.candidates, candidates);
    assert.deepEqual(f.database.connection.prepare("SELECT * FROM prompt_history WHERE version=1 ORDER BY kind,shot_key,version").all(), histories);
    assert.equal((await confirm(f)).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(hasCurrentConfirmation(w, "realistic"), true); verifyClosedReopen(f, w);
  } finally { f.close(); }
});


test("media responses use exactly hash-verified bounded bytes without caching; replacement is rejected and repair becomes visible", async () => {
  const f = await fixture(); try {
    const id = f.image.id, path = f.store.pathFor(id)!, original = readFileSync(path);
    const response = verifiedMediaResponse("GET", id, imageId => f.store.readVerifiedBytes(imageId));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "image/png");
    const replacement = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#ff0000" } }).png().toBuffer();
    writeFileSync(path, replacement);
    // A completed read is a verified snapshot, not a second unchecked fetch after path replacement.
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    assert.equal(f.store.readVerifiedBytes(id), null);
    assert.equal(verifiedMediaResponse("GET", id, imageId => f.store.readVerifiedBytes(imageId)).status, 404);
    truncateSync(path, 20 * 1024 * 1024 + 1); assert.equal(f.store.readVerifiedBytes(id), null);
    assert.equal(f.store.readVerifiedBytes("../workspace.sqlite"), null);
    let invoked = false;
    assert.equal(verifiedMediaResponse("POST", id, () => { invoked = true; return original; }).status, 404); assert.equal(invoked, false);
    const repaired = await f.store.importFile(f.tasks[0]!.id, f.file); assert.equal(repaired.id, id);
    const restored = verifiedMediaResponse("GET", id, imageId => f.store.readVerifiedBytes(imageId));
    assert.equal(restored.status, 200); assert.deepEqual(Buffer.from(await restored.arrayBuffer()), original);
    assert.equal(verifiedMediaResponse("GET", id, () => { throw new Error("read failure"); }).headers.get("cache-control"), "no-store");
  } finally { f.close(); }
});


// Mirrors the existing panel removal action: candidate metadata only, never the archive.
function withoutCandidate(workspace: TaskWorkspace, id: string): TaskWorkspace {
  const candidate = frameState(workspace).candidates.find(item => item.id === id)!;
  const current = frameState(workspace).firstId === id || frameState(workspace).lastId === id;
  const next = current ? chooseFrame(workspace, candidate.slot, null) : workspace;
  return { ...next, frames: { ...frameState(next), candidates: frameState(next).candidates.filter(item => item.id !== id) } };
}

test("same archived image can serve separate roles; unused removal preserves confirmation while current removal clears only its own role and never deletes archive", async () => {
  const f = await fixture(); try {
    let w = addFrameCandidate(f.workspace, "realistic", "first", f.image.id, randomUUID(), new Date().toISOString());
    const unused = w.frames!.candidates.at(-1)!.id;
    assert.equal((await save(f, w)).ok, true); assert.equal((await confirm(f)).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    const first = currentFrame(w, "first")!, last = currentFrame(w, "last")!, confirmed = w.frames!.confirmation;
    assert.notEqual(first.id, last.id); assert.equal(first.imageId, last.imageId);
    assert.equal((await save(f, withoutCandidate(w, unused))).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(hasCurrentConfirmation(w, "realistic"), true); assert.deepEqual(w.frames!.confirmation, confirmed);
    assert.equal((await save(f, withoutCandidate(w, first.id))).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(currentFrame(w, "first"), undefined); assert.deepEqual(currentFrame(w, "last"), last);
    assert.equal(w.frames!.confirmation!.invalidated, true); assert.equal(f.store.isAvailable(f.image.id), true);
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM reference_images WHERE id=?").get(f.image.id)!.n, 1);
    const newId = randomUUID(); w = addFrameCandidate(w, "realistic", "first", f.image.id, newId, new Date().toISOString());
    w = chooseFrame(w, "first", newId); assert.equal((await save(f, w)).ok, true);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(hasCurrentConfirmation(w, "realistic"), false); assert.deepEqual(currentFrame(w, "last"), last);
    verifyClosedReopen(f, w);
  } finally { f.close(); }
});

test("dirty prompt and candidate removal survive revision conflict until explicit overwrite or discard, without deleting shared archive", async () => {
  for (const choice of ["overwrite", "discard"] as const) {
    const f = await fixture(); let saver: WorkspaceAutosave | undefined;
    try {
      assert.equal((await save(f, f.workspace)).ok, true); assert.equal((await confirm(f)).ok, true);
      const task = f.repository.getTask(f.tasks[0]!.id), first = currentFrame(task.workspace, "first")!, last = currentFrame(task.workspace, "last")!;
      saver = new WorkspaceAutosave(task, async (workspace, revision) => {
        const result = await f.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: { id: task.id, expectedRevision: revision, workspace } }, { trusted: true });
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, requestId: result.requestId });
        return f.repository.getTask(task.id);
      }, () => {}, 60000);
      const draft = withoutCandidate(editPrompt(task.workspace, "realistic", "video", null, "未保存手写内容"), first.id);
      saver.update(draft);
      assert.equal((await save(f, { ...task.workspace, viewport: { x: 900, y: 800, zoom: 1 } })).ok, true);
      const remote = f.repository.getTask(task.id), receipts = f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n;
      assert.equal(await saver.flush(), false); assert.equal(saver.state.conflict, true); assert.equal(saver.state.dirty, true);
      assert.deepEqual(saver.workspace, draft); assert.deepEqual(f.repository.getTask(task.id), remote);
      assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, receipts);
      assert.equal(f.store.isAvailable(f.image.id), true);
      assert.equal(await saver.resolveConflict(remote, choice), true);
      const final = f.repository.getTask(task.id).workspace;
      if (choice === "overwrite") {
        assert.equal(currentFrame(final, "first"), undefined); assert.equal(findPrompt(final, "video", null)!.text, "未保存手写内容");
        assert.equal(final.frames!.confirmation!.invalidated, true);
      } else { assert.deepEqual(final, remote.workspace); assert.deepEqual(saver.workspace, remote.workspace); }
      assert.deepEqual(currentFrame(final, "last"), last); assert.equal(f.store.isAvailable(f.image.id), true);
      saver.dispose(); f.database.close(); const db = new ApplicationDatabase(f.path);
      try { const app = createApplicationServices({ database: db, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: f.directory }); assert.deepEqual(app.repository.getTask(task.id).workspace, final); }
      finally { db.close(); }
    } finally { saver?.dispose(); f.close(); }
  }
});

test("candidate imported from dirty prompt keeps unsaved-version provenance across later prompt save and same-image archive repair", async () => {
  const f = await fixture(); try {
    let w = editPrompt(f.workspace, "realistic", "firstFrame", null, "尚未保存的图片词");
    const id = randomUUID(); w = addFrameCandidate(w, "realistic", "first", f.image.id, id, new Date().toISOString(), false);
    w = chooseFrame(w, "first", id); const provenance = structuredClone(currentFrame(w, "first")!);
    assert.equal(provenance.promptVersion, null); assert.equal(provenance.promptText, "尚未保存的图片词");
    assert.equal((await save(f, w)).ok, true); w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.equal(findPrompt(w, "firstFrame", null)!.version, 1); assert.deepEqual(currentFrame(w, "first"), provenance);
    assert.equal((await save(f, editPrompt(w, "realistic", "firstFrame", null, "后来保存的图片词"))).ok, true);
    const path = f.store.pathFor(f.image.id)!; writeFileSync(path, "synthetic damaged image");
    assert.equal(f.store.isAvailable(f.image.id), false);
    const image = await f.store.importFile(f.tasks[0]!.id, f.file); assert.equal(image.id, f.image.id);
    w = f.repository.getTask(f.tasks[0]!.id).workspace;
    assert.deepEqual(currentFrame(w, "first"), provenance); assert.equal(findPrompt(w, "firstFrame", null)!.version, 2);
    assert.equal(f.store.isAvailable(image.id), true); verifyClosedReopen(f, w);
  } finally { f.close(); }
});
