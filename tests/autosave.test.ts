import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceAutosave } from "../src/shared/workspace-autosave";
import type { TaskWorkspace, VideoTask } from "../src/shared/models";
import { frameState, confirmationInput, invalidateChangedConfirmation } from "../src/shared/frames";
import { editPrompt } from "../src/shared/prompts";

const task = (): VideoTask => ({ id: "test", planId: "plan", title: "test", businessDate: "2026-11-18", sequence: 1,
  status: "draft", revision: 3, updatedAt: "", workspace: { script: "", scriptPosition: { x: 0, y: 0 },
    viewport: { x: 0, y: 0, zoom: 1 }, assets: [], shots: [], assetLinks: [] } });
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test("first prompt save advances the committed revision used to refresh history even when version remains one", async () => {
  const initial = task();
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => ({ ...initial, workspace, revision: revision + 1 }), () => {}, 800);
  try {
    const before = saver.savedRevision;
    saver.update(editPrompt(initial.workspace, "comic", "video", null, "first prompt"));
    assert.equal(saver.workspace.prompts![0]!.version, 1); assert.equal(saver.savedRevision, before);
    assert.equal(await saver.flush(), true);
    assert.equal(saver.workspace.prompts![0]!.version, 1); assert.equal(saver.savedRevision, before + 1);
  } finally { saver.dispose(); }
});

test("rapid input A-B-A before autosave keeps confirmation invalidated while layout-only edits preserve it", async () => {
  const initial = task(), plan = { style: "comic" as const, styleNotes: "plan notes" };
  initial.workspace.script = "A";
  initial.workspace.frames = { ...frameState(initial.workspace), confirmation: {
    inputSnapshot: confirmationInput(initial.workspace, plan), confirmedAt: new Date().toISOString(), invalidated: false,
  } };
  const moved = invalidateChangedConfirmation(initial.workspace, { ...initial.workspace, viewport: { x: 40, y: 50, zoom: 1 }, scriptPosition: { x: 500, y: 300 } }, plan);
  assert.equal(moved.frames!.confirmation!.invalidated, false);
  const writes: TaskWorkspace[] = [];
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => {
    writes.push(workspace); return { ...initial, workspace, revision: revision + 1 };
  }, () => {}, 50);
  try {
    saver.update(invalidateChangedConfirmation(saver.workspace, { ...saver.workspace, script: "B" }, plan));
    saver.update(invalidateChangedConfirmation(saver.workspace, { ...saver.workspace, script: "A" }, plan));
    assert.equal(await saver.flush(), true);
    assert.equal(writes.length, 1); assert.equal(writes[0]!.script, "A");
    assert.equal(writes[0]!.frames!.confirmation!.invalidated, true);
  } finally { saver.dispose(); }
});
const conflictError = () => Object.assign(new Error("版本已变化"), { code: "CONFLICT" });

test("conflict preserves copyable draft and explicit overwrite uses reviewed revision, rejecting a second competing update", async () => {
  const initial = task(); let server = { ...initial, revision: 4, workspace: { ...initial.workspace, script: "remote" } };
  const revisions: number[] = [];
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => {
    revisions.push(revision);
    if (revision !== server.revision) throw conflictError();
    server = { ...server, workspace, revision: revision + 1 }; return server;
  }, () => {}, 5);
  try {
    saver.update({ ...initial.workspace, script: "local draft" });
    assert.equal(await saver.flush(), false);
    assert.equal(saver.state.conflict, true);
    assert.equal(JSON.parse(JSON.stringify(saver.workspace)).script, "local draft");
    assert.equal(await saver.flush(true), false);
    await wait(); assert.deepEqual(revisions, [3]);
    const reviewed = structuredClone(server);
    server = { ...server, revision: 5, workspace: { ...server.workspace, script: "newer remote" } };
    assert.equal(await saver.resolveConflict(reviewed, "overwrite"), false);
    assert.equal(server.workspace.script, "newer remote");
    assert.equal(saver.workspace.script, "local draft");
    assert.equal(saver.state.conflict, true);
    assert.equal(await saver.resolveConflict(server, "overwrite"), true);
    assert.deepEqual(revisions, [3, 4, 5]);
    assert.equal(server.workspace.script, "local draft");
    assert.equal(saver.state.dirty, false);
    assert.equal(saver.state.conflict, false);
  } finally { saver.dispose(); }
});

test("explicit discard adopts reviewed saved task without writing and resumes editing at its revision", async () => {
  const initial = task(), revisions: number[] = [];
  let reject = true;
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => {
    revisions.push(revision); if (reject) throw conflictError();
    return { ...initial, workspace, revision: revision + 1 };
  }, () => {}, 500);
  try {
    saver.update({ ...initial.workspace, script: "discard me" }); await saver.flush();
    const remote = { ...initial, revision: 9, workspace: { ...initial.workspace, script: "saved version" } };
    assert.throws(() => saver.resolveConflict({ ...remote, id: "wrong task" }, "discard"));
    assert.equal(saver.workspace.script, "discard me");
    assert.equal(await saver.resolveConflict(remote, "discard"), true);
    assert.deepEqual(revisions, [3]); assert.equal(saver.workspace.script, "saved version");
    assert.equal(saver.state.dirty, false);
    reject = false; saver.update({ ...saver.workspace, script: "new edit" });
    assert.equal(await saver.flush(), true); assert.deepEqual(revisions, [3, 9]);
  } finally { saver.dispose(); }
});

test("ordinary disk errors cannot enter overwrite or discard conflict resolution", async () => {
  const initial = task();
  const saver = new WorkspaceAutosave(initial, async () => { throw Object.assign(new Error("disk full"), { code: "STORAGE_ERROR" }); }, () => {}, 500);
  try {
    saver.update({ ...initial.workspace, script: "keep" }); await saver.flush();
    assert.equal(saver.state.conflict, false);
    assert.equal(await saver.resolveConflict({ ...initial, revision: 10 }, "overwrite"), false);
    assert.equal(await saver.resolveConflict({ ...initial, revision: 10 }, "discard"), false);
    assert.equal(saver.workspace.script, "keep"); assert.equal(saver.savedRevision, 3);
  } finally { saver.dispose(); }
});

test("autosave debounces edits and normalizes only the saved latest draft", async () => {
  const initial = task(), writes: string[] = [];
  let normalized: TaskWorkspace | undefined;
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => {
    writes.push(workspace.script);
    return { ...initial, revision: revision + 1, workspace: { ...workspace, script: workspace.script + "!" } };
  }, (_state, value) => { if (value) normalized = value; }, 5);
  try {
    saver.update({ ...initial.workspace, script: "a" });
    saver.update({ ...initial.workspace, script: "ab" });
    saver.update({ ...initial.workspace, script: "abc" });
    await wait();
    assert.deepEqual(writes, ["abc"]);
    assert.equal(normalized?.script, "abc!");
    assert.deepEqual(saver.state, { dirty: false, saving: false, error: null, conflict: false });
  } finally { saver.dispose(); }
});

test("in-flight edits serialize, use returned revision, and cannot be overwritten by older reply", async () => {
  const initial = task(), writes: [string, number][] = [], applied: string[] = [];
  let release!: (task: VideoTask) => void;
  const saver = new WorkspaceAutosave(initial, (workspace, revision) => {
    writes.push([workspace.script, revision]);
    if (writes.length === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ ...initial, revision: revision + 1, workspace });
  }, (_state, value) => { if (value) applied.push(value.script); }, 500);
  try {
    saver.update({ ...initial.workspace, script: "old" });
    const first = saver.flush();
    await Promise.resolve();
    saver.update({ ...initial.workspace, script: "new" });
    assert.equal(saver.flush(), first);
    release({ ...initial, revision: 4, workspace: { ...initial.workspace, script: "old" } });
    assert.equal(await first, true);
    assert.deepEqual(writes, [["old", 3], ["new", 4]]);
    assert.deepEqual(applied, ["new"]);
    assert.equal(saver.workspace.script, "new");
    assert.equal(saver.state.dirty, false);
  } finally { saver.dispose(); }
});

test("save failure retains latest draft and does not spin until explicit retry", async () => {
  const initial = task(); let count = 0;
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => {
    if (++count === 1) throw new Error("磁盘不可写");
    return { ...initial, workspace, revision: revision + 1 };
  }, () => {}, 5);
  try {
    saver.update({ ...initial.workspace, script: "draft" });
    assert.equal(await saver.flush(), false);
    saver.update({ ...initial.workspace, script: "new draft" });
    await wait();
    assert.equal(count, 1);
    assert.equal(saver.state.error, "磁盘不可写");
    assert.equal(saver.workspace.script, "new draft");
    assert.equal(await saver.flush(), false);
    assert.equal(await saver.flush(true), true);
    assert.equal(count, 2);
    assert.equal(saver.state.error, null);
  } finally { saver.dispose(); }
});

test("pause protects import snapshot; flush and confirmation accept use the current revision", async () => {
  const initial = task(), revisions: number[] = [];
  const saver = new WorkspaceAutosave(initial, async (workspace, revision) => {
    revisions.push(revision); return { ...initial, workspace, revision: revision + 1 };
  }, () => {}, 5);
  try {
    saver.pause(true);
    saver.update({ ...initial.workspace, script: "importing" });
    await wait();
    assert.equal(await saver.flush(), false);
    assert.throws(() => saver.accept(initial));
    saver.pause(false);
    assert.equal(await saver.flush(), true);
    saver.accept({ ...initial, workspace: saver.workspace, revision: 5 });
    saver.update({ ...saver.workspace, script: "after confirmation" });
    assert.equal(await saver.flush(), true);
    assert.deepEqual(revisions, [3, 5]);
  } finally { saver.dispose(); }
});

test("disposal cancels queued save and does not emit late results", async () => {
  const initial = task(); let writes = 0, notifications = 0;
  let release!: (task: VideoTask) => void;
  const saver = new WorkspaceAutosave(initial, () => { writes++; return new Promise(resolve => { release = resolve; }); },
    () => { notifications++; }, 5);
  saver.update({ ...initial.workspace, script: "a" });
  const pending = saver.flush(); await Promise.resolve();
  saver.update({ ...initial.workspace, script: "b" });
  saver.dispose(); const before = notifications;
  release({ ...initial, revision: 4 }); await pending; await wait();
  assert.equal(notifications, before); assert.equal(writes, 1);
  const queued = new WorkspaceAutosave(initial, async () => { writes++; return initial; }, () => {}, 5);
  queued.update({ ...initial.workspace, script: "queued" }); queued.dispose(); await wait();
  assert.equal(writes, 1);
});
