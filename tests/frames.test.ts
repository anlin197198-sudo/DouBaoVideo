import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { createApplicationServices } from "../src/main/application/services";
import { addFrameCandidate, chooseFrame, confirmationBlocker, confirmationIssue, currentFrame, frameState, hasCurrentConfirmation } from "../src/shared/frames";
import { editPrompt, reviewPrompt } from "../src/shared/prompts";
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
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
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
