import { removeV7Schema } from "./removal-schema-fixture";
import { WorkspaceBackup } from "../src/main/infrastructure/workspace-backup";
import { validateBackupDirectory } from "../src/main/infrastructure/backup-validation";
import { IsolatedRestore } from "../src/main/infrastructure/isolated-restore";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
function services(database: ApplicationDatabase) { return createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" }); }
function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path), app = services(database);
  const { tasks } = database.transaction(() => app.repository.createPlan({ title: "script history", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" }));
  return { database, ...app, tasks };
}
function request(f: ReturnType<typeof fixture>, id: string, text: string, revision?: number, requestId = randomUUID()) {
  const current = f.repository.getTask(id);
  return { requestId, command: "tasks.saveWorkspace", input: { id, expectedRevision: revision ?? current.revision, workspace: { ...current.workspace, script: text } } };
}

test("new tasks have no fabricated empty edit; exact changes including whitespace and clearing append, identical save and receipt retry do not", async () => {
  const f = fixture(); try {
    const id = f.tasks[0]!.id;
    assert.deepEqual(f.repository.listScriptHistory({ taskId: id }).items, []);
    await f.router.dispatch(request(f, id, ""), { trusted: true });
    assert.equal(f.repository.listScriptHistory({ taskId: id }).items.length, 0);
    const first = request(f, id, "第一稿");
    assert.equal((await f.router.dispatch(first, { trusted: true })).ok, true);
    assert.equal((await f.router.dispatch(first, { trusted: true })).ok, true);
    for (const text of ["第一稿", "第一稿 ", "", "new", "last"]) assert.equal((await f.router.dispatch(request(f, id, text), { trusted: true })).ok, true);
    const all = f.repository.listScriptHistory({ taskId: id }); assert.equal(all.items.length, 5);
    assert.equal(f.repository.getScriptHistory({ taskId: id, version: 3 }).text, "");
    assert.equal(f.repository.getScriptHistory({ taskId: id, version: 2 }).text, "第一稿 ");
    const page = f.repository.listScriptHistory({ taskId: id, limit: 2 }); assert.deepEqual(page.items.map(item => item.version), [5, 4]); assert.equal(page.nextBeforeVersion, 4);
    assert.deepEqual(f.repository.listScriptHistory({ taskId: id, limit: 2, beforeVersion: 4 }).items.map(item => item.version), [3, 2]);
    assert.ok(all.items.every(item => item.recordType === "saved" && !("text" in item)));
    assert.throws(() => f.database.connection.exec("UPDATE script_history SET text='bad'"), /immutable/);
    assert.throws(() => f.database.connection.exec("DELETE FROM script_history"), /immutable/);
  } finally { f.database.close(); }
});

test("script history reads are scoped, strict bounded and non-transactional; stale saves do not append", async () => {
  const f = fixture(); try {
    const id = f.tasks[0]!.id, first = request(f, id, "A", 0), stale = request(f, id, "B", 0);
    const results = await Promise.all([f.router.dispatch(first, { trusted: true }), f.router.dispatch(stale, { trusted: true })]);
    assert.deepEqual(results.map(r => r.ok), [true, false]);
    assert.equal(f.repository.listScriptHistory({ taskId: id }).items.length, 1);
    assert.throws(() => f.repository.getScriptHistory({ taskId: f.tasks[1]!.id, version: 1 }), /没有该剧本/);
    const receipts = f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n;
    for (const input of [{ taskId: id, limit: 31 }, { taskId: id, limit: 0 }, { taskId: id, beforeVersion: -1 }, { taskId: id, extra: "bad" }])
      assert.equal((await f.router.dispatch({ requestId: randomUUID(), command: "scripts.historyList", input }, { trusted: true })).ok, false);
    for (const command of ["scripts.historyList", "scripts.historyDetail"] as const) {
      const input = command === "scripts.historyList" ? { taskId: id } : { taskId: id, version: 1 };
      assert.equal((await f.router.dispatch({ requestId: randomUUID(), command, input }, { trusted: true })).ok, true);
      assert.equal((await f.router.dispatch({ requestId: randomUUID(), command, input }, { trusted: false })).ok, false);
    }
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, receipts);
  } finally { f.database.close(); }
});

test("history insert failure rolls back script, revision, other workspace changes and command receipt", async () => {
  const f = fixture(); try {
    const id = f.tasks[0]!.id, before = f.repository.getTask(id), req = request(f, id, "not committed");
    f.database.connection.exec("CREATE TRIGGER synthetic_script_failure BEFORE INSERT ON script_history BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.equal((await f.router.dispatch(req, { trusted: true })).ok, false);
    assert.deepEqual(f.repository.getTask(id), before); assert.equal(f.repository.listScriptHistory({ taskId: id }).items.length, 0);
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, 0);
    f.database.connection.exec("DROP TRIGGER synthetic_script_failure;");
    assert.equal((await f.router.dispatch(req, { trusted: true })).ok, true); assert.equal(f.repository.listScriptHistory({ taskId: id }).items.length, 1);
  } finally { f.database.close(); }
});

test("V5 migration records exactly one current baseline including empty and reopen adds nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-migrate-")), path = join(dir, "workspace.sqlite"), f = fixture(path);
  try {
    const id = f.tasks[0]!.id, workspace = { ...f.tasks[0]!.workspace, script: "only known current script" };
    f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(workspace), id);
    f.database.connection.exec(removeV7Schema + "DROP TABLE script_history; PRAGMA user_version=5;"); f.database.close();
    const before = new Date().toISOString(), migrated = new ApplicationDatabase(path);
    try {
      const app = services(migrated), baseline = app.repository.getScriptHistory({ taskId: id, version: 1 });
      assert.equal(migrated.version, 7); assert.equal(baseline.recordType, "baseline"); assert.equal(baseline.text, workspace.script); assert.ok(baseline.recordedAt >= before);
      assert.equal(app.repository.getScriptHistory({ taskId: f.tasks[1]!.id, version: 1 }).text, "");
      assert.deepEqual(app.repository.getTask(id).workspace, workspace);
      assert.equal(migrated.connection.prepare("SELECT COUNT(*) n FROM script_history").get()!.n, 7);
    } finally { migrated.close(); }
    const reopened = new ApplicationDatabase(path); try { assert.equal(reopened.connection.prepare("SELECT COUNT(*) n FROM script_history").get()!.n, 7); } finally { reopened.close(); }
  } finally { if (f.database.connection.isOpen) f.database.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid legacy script aborts V6 without losing V5 data or leaving a partial table", () => {
  for (const bad of ["broken-json", JSON.stringify({ script: 42 }), JSON.stringify({ script: "x".repeat(100001) })]) {
    const dir = mkdtempSync(join(tmpdir(), "script-bad-")), path = join(dir, "workspace.sqlite"), f = fixture(path);
    try {
      f.database.connection.exec(removeV7Schema + "DROP TABLE script_history; PRAGMA user_version=5;");
      f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(bad, f.tasks.at(-1)!.id); f.database.close();
      assert.throws(() => new ApplicationDatabase(path), /剧本历史迁移已回滚/);
      const raw = new DatabaseSync(path);
      try {
        assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 5);
        assert.equal(raw.prepare("SELECT name FROM sqlite_schema WHERE name='script_history'").get(), undefined);
        assert.equal(raw.prepare("SELECT workspace_json FROM tasks WHERE id=?").get(f.tasks.at(-1)!.id)!.workspace_json, bad);
      } finally { raw.close(); }
    } finally { if (f.database.connection.isOpen) f.database.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});


test("V7 backup and isolated restore preserve durable script versions with trusted V7 schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "script-backup-")), live = join(root, "live"), backups = join(root, "backups"), output = join(root, "restore");
  for (const path of [live, backups, output]) mkdirSync(path);
  const f = fixture(join(live, "workspace.sqlite"));
  try {
    const id = f.tasks[0]!.id;
    await f.router.dispatch(request(f, id, "original saved"), { trusted: true });
    await f.router.dispatch(request(f, id, "latest saved"), { trusted: true });
    const decode = async (_bytes: Buffer): Promise<{ png: Buffer; width: number; height: number }> => { throw new Error("no images in this synthetic fixture"); };
    const result = await new WorkspaceBackup({ database: f.database, mediaDirectory: join(live, "media"), applicationVersion: "test", chooseDirectory: async () => backups, decode }).create();
    assert.equal(result!.databaseVersion, 7);
    assert.equal((await validateBackupDirectory(result!.directory, decode)).databaseVersion, 7);
    const restored = await new IsolatedRestore({ currentWorkspace: live, decode }).restore(result!.directory, output);
    const raw = new DatabaseSync(join(restored.directory, "workspace.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(raw.prepare("SELECT version,text,record_type FROM script_history WHERE task_id=? ORDER BY version").all(id).map(row => ({ ...row })), [
        { version: 1, text: "original saved", record_type: "saved" }, { version: 2, text: "latest saved", record_type: "saved" },
      ]);
      assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 7);
    } finally { raw.close(); }
  } finally { f.database.close(); rmSync(root, { recursive: true, force: true }); }
});
