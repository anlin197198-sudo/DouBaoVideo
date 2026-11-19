import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { editPrompt, reviewPrompt } from "../src/shared/prompts";
import { addShot, removeShot } from "../src/shared/storyboard";
import { HistoryReads, LatestRead } from "../src/shared/latest-read";

function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, dataDirectory: "isolated", version: "test" });
  const created = database.transaction(() => services.repository.createPlan({ title: "历史", style: "comic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" }));
  return { database, ...services, ...created };
}

test("all four prompt types append immutable saved history; same save and request replay do not duplicate; pages are scoped", async () => {
  const f = fixture();
  try {
    const task = f.tasks[0]!, shotId = randomUUID();
    let workspace = addShot({ ...task.workspace, script: "故事" }, shotId);
    for (const kind of ["shot", "video", "firstFrame", "lastFrame"] as const) workspace = editPrompt(workspace, f.plan, kind, kind === "shot" ? shotId : null, `${kind} first`);
    const request = { requestId: randomUUID(), command: "tasks.saveWorkspace", input: { id: task.id, expectedRevision: 0, workspace } };
    const first = await f.router.dispatch(request, { trusted: true }); assert.equal(first.ok, true);
    assert.deepEqual(await f.router.dispatch(request, { trusted: true }), first);
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM prompt_history").get()!.n, 4);
    let current = f.repository.getTask(task.id);
    f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: current.revision, workspace: current.workspace }));
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM prompt_history").get()!.n, 4);
    for (let index = 2; index <= 6; index++) {
      current = f.repository.getTask(task.id);
      f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: current.revision,
        workspace: editPrompt(current.workspace, f.plan, "video", null, `video ${index}`) }));
    }
    const list = f.repository.listPromptHistory({ taskId: task.id, kind: "video", shotId: null, limit: 2 });
    assert.deepEqual(list.items.map(item => item.version), [6, 5]); assert.equal(list.nextBeforeVersion, 5);
    assert.equal("text" in list.items[0]!, false);
    assert.deepEqual(f.repository.listPromptHistory({ taskId: task.id, kind: "video", shotId: null, beforeVersion: 5, limit: 2 }).items.map(item => item.version), [4, 3]);
    assert.equal(f.repository.getPromptHistory({ taskId: task.id, kind: "video", shotId: null, version: 1 }).text, "video first");
    assert.equal(f.repository.getPromptHistory({ taskId: task.id, kind: "shot", shotId, version: 1 }).text, "shot first");
    assert.throws(() => f.repository.getPromptHistory({ taskId: f.tasks[1]!.id, kind: "shot", shotId, version: 1 }), /没有该历史版本/);
    assert.throws(() => f.database.connection.exec("UPDATE prompt_history SET text='changed'"), /immutable/);
    assert.throws(() => f.database.connection.exec("DELETE FROM prompt_history"), /immutable/);
    const receipts = f.database.connection.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()!.n;
    const result = await f.router.dispatch({ requestId: randomUUID(), command: "prompts.historyList", input: { taskId: task.id, kind: "video", shotId: null, limit: 31 } }, { trusted: true });
    assert.equal(result.ok, false);
    await f.router.dispatch({ requestId: randomUUID(), command: "prompts.historyList", input: { taskId: task.id, kind: "video", shotId: null } }, { trusted: true });
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()!.n, receipts);
  } finally { f.database.close(); }
});

test("deleted and reintroduced same shot gets next historical version; input-only review also records a version", () => {
  const f = fixture();
  try {
    const task = f.tasks[0]!, shotId = randomUUID();
    let workspace = editPrompt(addShot({ ...task.workspace, script: "A" }, shotId), f.plan, "shot", shotId, "原文");
    let saved = f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: 0, workspace }));
    saved = f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: saved.revision, workspace: removeShot(saved.workspace, shotId) }));
    workspace = editPrompt(addShot(saved.workspace, shotId), f.plan, "shot", shotId, "重建");
    saved = f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: saved.revision, workspace }));
    assert.equal(saved.workspace.prompts![0]!.version, 2);
    workspace = reviewPrompt({ ...saved.workspace, script: "B" }, f.plan, "shot", shotId);
    saved = f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: saved.revision, workspace }));
    assert.equal(saved.workspace.prompts![0]!.version, 3);
    assert.equal(f.repository.getPromptHistory({ taskId: task.id, kind: "shot", shotId, version: 1 }).text, "原文");
    assert.equal(f.repository.getPromptHistory({ taskId: task.id, kind: "shot", shotId, version: 3 }).text, "重建");
  } finally { f.database.close(); }
});

test("history write failure rolls back workspace revision and command receipt in the same transaction", async () => {
  const f = fixture();
  try {
    const task = f.tasks[0]!, requestId = randomUUID();
    f.database.connection.exec("CREATE TRIGGER fail_history BEFORE INSERT ON prompt_history BEGIN SELECT RAISE(ABORT,'test history failure'); END;");
    const result = await f.router.dispatch({ requestId, command: "tasks.saveWorkspace", input: { id: task.id, expectedRevision: 0,
      workspace: editPrompt(task.workspace, f.plan, "video", null, "失败不能伪造历史") } }, { trusted: true });
    assert.equal(result.ok, false); assert.deepEqual(f.repository.getTask(task.id), task);
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM prompt_history").get()!.n, 0);
    assert.equal(f.database.connection.prepare("SELECT request_id FROM command_receipts WHERE request_id=?").get(requestId), undefined);
  } finally { f.database.close(); }
});

test("V4 upgrade records only current-version baseline with first-recorded time, preserving text and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-history-migration-")), path = join(directory, "workspace.sqlite");
  let database: ApplicationDatabase | undefined;
  try {
    const f = fixture(path); database = f.database; const task = f.tasks[0]!;
    const workspace = editPrompt(task.workspace, f.plan, "video", null, "已有第七版"); workspace.prompts![0]!.version = 7;
    database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(workspace), task.id);
    database.connection.exec("DROP TABLE prompt_history; PRAGMA user_version=4;"); database.close();
    const before = new Date().toISOString(); database = new ApplicationDatabase(path);
    const row = database.connection.prepare("SELECT * FROM prompt_history").get()!;
    assert.equal(row.version, 7); assert.equal(row.record_type, "baseline"); assert.equal(row.text, "已有第七版");
    assert.ok(String(row.recorded_at) >= before); assert.equal(database.version, 5);
    assert.equal(database.connection.prepare("SELECT workspace_json FROM tasks WHERE id=?").get(task.id)!.workspace_json, JSON.stringify(workspace));
    database.close(); database = new ApplicationDatabase(path);
    assert.equal(database.connection.prepare("SELECT COUNT(*) AS n FROM prompt_history").get()!.n, 1);
  } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("invalid workspace aborts only history migration with no baseline table or lost source JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-history-bad-")), path = join(directory, "workspace.sqlite");
  try {
    const f = fixture(path), id = f.tasks[0]!.id;
    f.database.connection.exec("DROP TABLE prompt_history; PRAGMA user_version=4;");
    f.database.connection.prepare("UPDATE tasks SET workspace_json='broken' WHERE id=?").run(id); f.database.close();
    assert.throws(() => new ApplicationDatabase(path), /历史版本迁移已回滚/);
    const raw = new DatabaseSync(path);
    try {
      assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 4);
      assert.equal(raw.prepare("SELECT name FROM sqlite_schema WHERE name='prompt_history'").get(), undefined);
      assert.equal(raw.prepare("SELECT workspace_json FROM tasks WHERE id=?").get(id)!.workspace_json, "broken");
    } finally { raw.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("history read generation rejects late results after switching selection or closing", () => {
  const scope = new LatestRead();
  const first = scope.begin(), second = scope.begin();
  assert.equal(scope.current(first), false); assert.equal(scope.current(second), true);
  scope.cancel(); assert.equal(scope.current(second), false);
  const reopened = scope.begin(); assert.equal(scope.current(reopened), true);
});


test("autosave history list refresh leaves selected detail pending, close cancels both channels", () => {
  const reads = new HistoryReads();
  const firstList = reads.list.begin(), detail = reads.detail.begin();
  const savedList = reads.list.begin();
  assert.equal(reads.list.current(firstList), false);
  assert.equal(reads.list.current(savedList), true);
  assert.equal(reads.detail.current(detail), true);
  reads.list.cancel(); // savedRevision effect cleanup
  assert.equal(reads.detail.current(detail), true);
  const latestDetail = reads.detail.begin();
  assert.equal(reads.detail.current(detail), false);
  const latestList = reads.list.begin();
  reads.cancel(); // close, prompt switch or unmount
  assert.equal(reads.list.current(latestList), false);
  assert.equal(reads.detail.current(latestDetail), false);
  assert.equal(reads.list.current(reads.list.begin()), true);
  assert.equal(reads.detail.current(reads.detail.begin()), true);
});


test("delayed history responses survive autosave refresh but never close or a newer selection", async () => {
  const reads = new HistoryReads();
  function delayed<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
  let list: string[] = [], detail = "";
  const oldList = delayed<string[]>(), freshList = delayed<string[]>(), selected = delayed<string>();
  const oldToken = reads.list.begin();
  const oldDone = oldList.promise.then(value => { if (reads.list.current(oldToken)) list = value; });
  const detailToken = reads.detail.begin();
  const detailDone = selected.promise.then(value => { if (reads.detail.current(detailToken)) detail = value; });
  reads.list.cancel();
  const freshToken = reads.list.begin();
  const freshDone = freshList.promise.then(value => { if (reads.list.current(freshToken)) list = value; });
  freshList.resolve(["v2", "v1"]); await freshDone;
  selected.resolve("old v1 text"); await detailDone;
  oldList.resolve(["v1"]); await oldDone;
  assert.deepEqual(list, ["v2", "v1"]); assert.equal(detail, "old v1 text");
  const pending = delayed<string>(), next = delayed<string>();
  const pendingToken = reads.detail.begin();
  const pendingDone = pending.promise.then(value => { if (reads.detail.current(pendingToken)) detail = value; });
  const nextToken = reads.detail.begin();
  const nextDone = next.promise.then(value => { if (reads.detail.current(nextToken)) detail = value; });
  reads.cancel(); // closing or unmounting the prompt key
  pending.resolve("superseded"); next.resolve("closed"); await Promise.all([pendingDone, nextDone]);
  assert.equal(detail, "old v1 text");
});
