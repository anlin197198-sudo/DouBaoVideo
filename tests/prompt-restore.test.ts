import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewPromptRestore, applyPromptRestore } from "../src/shared/prompt-restore";
import { editPrompt, findPrompt, promptInput, reviewPrompt } from "../src/shared/prompts";
import { confirmationInput, frameState, invalidateChangedConfirmation } from "../src/shared/frames";
import { addShot } from "../src/shared/storyboard";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import type { PromptHistoryDetail, PromptKind, TaskWorkspace } from "../src/shared/models";
function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" });
  const { plan, tasks } = database.transaction(() => services.repository.createPlan({ title: "restore prompt", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" }));
  const workspace = addShot({ ...tasks[0]!.workspace, script: "old script" }, randomUUID());
  return { database, ...services, plan, task: tasks[0]!, workspace };
}
function detail(text: string, inputSnapshot: string): PromptHistoryDetail {
  return { text, inputSnapshot, version: 1, recordedAt: "2026-11-19T00:00:00Z", recordType: "saved", textLength: text.length, inputLength: inputSnapshot.length };
}
const kinds: PromptKind[] = ["shot", "video", "firstFrame", "lastFrame"];

test("all four kinds restore only selected historical text/input as manual draft, preserving current version and immutable inputs", () => {
  const f = fixture(); try {
    let w = f.workspace;
    for (const kind of kinds) w = editPrompt(w, f.plan, kind, kind === "shot" ? w.shots[0]!.id : null, "current " + kind);
    w.prompts!.forEach(prompt => { prompt.version = 7; });
    for (const kind of kinds) {
      const shotId = kind === "shot" ? w.shots[0]!.id : null, history = detail("older " + kind, "historical snapshot"), original = structuredClone(w), oldHistory = structuredClone(history);
      const preview = previewPromptRestore(w, f.plan, kind, shotId, history); assert.equal(preview.changed, true);
      const next = applyPromptRestore(w, f.plan, preview), restored = findPrompt(next, kind, shotId)!;
      assert.equal(restored.text, history.text); assert.equal(restored.inputSnapshot, history.inputSnapshot); assert.equal(restored.version, 7); assert.equal(restored.source, "manual");
      assert.deepEqual(next.prompts!.filter(p => p.kind !== kind), w.prompts!.filter(p => p.kind !== kind));
      assert.deepEqual({ ...next, prompts: undefined }, { ...w, prompts: undefined });
      assert.deepEqual(w, original); assert.deepEqual(history, oldHistory);
    }
  } finally { f.database.close(); }
});

test("same text and snapshot is identity no-op; same text old snapshot remains stale and confirmation cannot revive after review", () => {
  const f = fixture(); try {
    let w = editPrompt(f.workspace, f.plan, "firstFrame", null, "same text");
    w.frames = { ...frameState(w), confirmation: { confirmedAt: "2026-11-19T00:00:00Z", invalidated: false, inputSnapshot: confirmationInput(w, f.plan) } };
    const current = findPrompt(w, "firstFrame", null)!;
    const identical = previewPromptRestore(w, f.plan, "firstFrame", null, detail(current.text, current.inputSnapshot));
    assert.equal(identical.changed, false); assert.equal(applyPromptRestore(w, f.plan, identical), w);
    const historical = previewPromptRestore(w, f.plan, "firstFrame", null, detail(current.text, "older dependencies"));
    const next = applyPromptRestore(w, f.plan, historical);
    assert.notEqual(findPrompt(next, "firstFrame", null)!.inputSnapshot, promptInput(next, f.plan, "firstFrame", null));
    assert.equal(next.frames!.confirmation!.invalidated, true);
    const reviewed = invalidateChangedConfirmation(next, reviewPrompt(next, f.plan, "firstFrame", null), f.plan);
    assert.equal(reviewed.frames!.confirmation!.invalidated, true);
    assert.deepEqual({ ...next.frames, confirmation: null }, { ...w.frames, confirmation: null });
  } finally { f.database.close(); }
});

test("confirmation rejects target/dependency/style/review changes, invalid scopes and deleted shots; layout-only remains allowed", () => {
  const f = fixture(); try {
    const w = editPrompt(f.workspace, f.plan, "shot", f.workspace.shots[0]!.id, "current"), shotId = w.shots[0]!.id;
    const preview = previewPromptRestore(w, f.plan, "shot", shotId, detail("old", "old input"));
    assert.throws(() => applyPromptRestore({ ...w, shots: [] }, f.plan, preview));
    assert.throws(() => applyPromptRestore(editPrompt(w, f.plan, "shot", shotId, "newer typing"), f.plan, preview), /重新预览/);
    assert.throws(() => applyPromptRestore({ ...w, script: "changed" }, f.plan, preview), /重新预览/);
    assert.throws(() => applyPromptRestore(w, { ...f.plan, styleNotes: "new" }, preview), /重新预览/);
    const confirmed = { ...w, frames: { ...frameState(w), confirmation: { inputSnapshot: "x", confirmedAt: "2026-11-19T00:00:00Z", invalidated: false } } };
    assert.throws(() => applyPromptRestore(confirmed, f.plan, preview), /重新预览/);
    for (const [kind, id] of [["video", shotId], ["shot", null], ["unknown", null]] as const) assert.throws(() => previewPromptRestore(w, f.plan, kind as PromptKind, id, detail("x", "y")));
    const moved = { ...w, viewport: { x: 77, y: 8, zoom: 2 } };
    assert.deepEqual(applyPromptRestore(moved, f.plan, preview).viewport, moved.viewport);
  } finally { f.database.close(); }
});

test("restoring a shot text makes video dependencies stale without overwriting other manual prompts", () => {
  const f = fixture(); try {
    const id = f.workspace.shots[0]!.id;
    let w = editPrompt(f.workspace, f.plan, "shot", id, "new shot text"); w = editPrompt(w, f.plan, "video", null, "keep video manual text");
    const next = applyPromptRestore(w, f.plan, previewPromptRestore(w, f.plan, "shot", id, detail("old shot text", promptInput(w, f.plan, "shot", id))));
    assert.equal(findPrompt(next, "video", null)!.text, "keep video manual text");
    assert.notEqual(findPrompt(next, "video", null)!.inputSnapshot, promptInput(next, f.plan, "video", null));
  } finally { f.database.close(); }
});

test("normal save records a new immutable version for every restored kind and reopens without rewriting history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prompt-restore-test-")), path = join(directory, "workspace.sqlite"), f = fixture(path);
  try {
    let task = { ...f.task, workspace: f.workspace };
    function save(workspace: TaskWorkspace) { return f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: task.revision, workspace })); }
    let w = task.workspace;
    for (const kind of kinds) w = editPrompt(w, f.plan, kind, kind === "shot" ? w.shots[0]!.id : null, "first " + kind);
    task = save(w);
    for (const kind of kinds) { const id = kind === "shot" ? task.workspace.shots[0]!.id : null; task = save(editPrompt(task.workspace, f.plan, kind, id, "second " + kind)); }
    for (const kind of kinds) {
      const shotId = kind === "shot" ? task.workspace.shots[0]!.id : null;
      const old = f.repository.getPromptHistory({ taskId: task.id, kind, shotId, version: 1 });
      const next = applyPromptRestore(task.workspace, f.plan, previewPromptRestore(task.workspace, f.plan, kind, shotId, old)); task = save(next);
      assert.equal(findPrompt(task.workspace, kind, shotId)!.version, 3);
      assert.deepEqual(f.repository.getPromptHistory({ taskId: task.id, kind, shotId, version: 1 }), old);
      assert.equal(f.repository.getPromptHistory({ taskId: task.id, kind, shotId, version: 2 }).text, "second " + kind);
      assert.equal(f.repository.getPromptHistory({ taskId: task.id, kind, shotId, version: 3 }).text, "first " + kind);
    }
    const reopened = new ApplicationDatabase(path);
    try { const services = createApplicationServices({ database: reopened, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" }); assert.deepEqual(services.repository.getTask(task.id).workspace.prompts, task.workspace.prompts); }
    finally { reopened.close(); }
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("snapshot-only restoration keeps an existing confirmation invalidated through save then explicit review and another save", () => {
  const f = fixture(); try {
    let w = editPrompt(f.workspace, f.plan, "firstFrame", null, "unchanged text");
    w.frames = { ...frameState(w), confirmation: { confirmedAt: "2026-11-19T00:00:00Z", invalidated: false, inputSnapshot: confirmationInput(w, f.plan) } };
    // Synthetic pre-existing confirmation isolates save's sticky-invalidation behavior;
    // image readiness/creation is covered by frames.test.ts, not claimed here.
    f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(w), f.task.id);
    const next = applyPromptRestore(w, f.plan, previewPromptRestore(w, f.plan, "firstFrame", null, detail("unchanged text", "older snapshot")));
    let saved = f.database.transaction(() => f.repository.saveWorkspace({ id: f.task.id, expectedRevision: 0, workspace: next }));
    assert.equal(saved.workspace.frames!.confirmation!.invalidated, true);
    saved = f.database.transaction(() => f.repository.saveWorkspace({ id: saved.id, expectedRevision: saved.revision, workspace: reviewPrompt(saved.workspace, f.plan, "firstFrame", null) }));
    assert.equal(saved.workspace.frames!.confirmation!.invalidated, true);
    assert.equal(findPrompt(saved.workspace, "firstFrame", null)!.inputSnapshot, promptInput(saved.workspace, f.plan, "firstFrame", null));
  } finally { f.database.close(); }
});
