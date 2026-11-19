import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { SqliteAccountRemovalStore } from "../src/main/infrastructure/account-removal-store";
import { createApplicationServices } from "../src/main/application/services";
import { WorkspaceBackup } from "../src/main/infrastructure/workspace-backup";
import { validateBackupDirectory } from "../src/main/infrastructure/backup-validation";
import { IsolatedRestore } from "../src/main/infrastructure/isolated-restore";
import { removeV7Schema } from "./removal-schema-fixture";
import type { RemovalLease } from "../src/main/application/account-removal-workflow";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "removal-store-")), live = join(root, "live"); mkdirSync(live);
  const path = join(live, "workspace.sqlite"), database = new ApplicationDatabase(path);
  let opened = 0;
  const app = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() { opened++; } }, version: "test", dataDirectory: live });
  const account = database.transaction(() => app.repository.createAccount("移除测试"));
  const other = database.transaction(() => app.repository.createAccount("保留测试"));
  const { tasks } = database.transaction(() => app.repository.createPlan({ title: "关联保留", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" }));
  const store = new SqliteAccountRemovalStore(database);
  const execution = (status: string, owner = account.id) => {
    const id = randomUUID(); database.connection.prepare("INSERT INTO executions(id,task_id,account_id,operation,status,input_json,created_at,updated_at) VALUES (?,?,?,'video',?,'{}','old','old')").run(id, tasks[0]!.id, owner, status); return id;
  };
  const begin = async () => { const result = await store.begin(account.id, (await store.read(account.id)).revision); assert.equal(result.status, "started"); return (result as { lease: RemovalLease }).lease; };
  return { root, live, path, database, app, account, other, tasks, store, execution, begin, opened: () => opened,
    close() { if (database.connection.isOpen) database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("two SQLite connections acquire one fenced lease; failed retry keeps operation, rotates token, and never reclaims an active crash lease", async () => {
  const f = fixture(), second = new ApplicationDatabase(f.path), b = new SqliteAccountRemovalStore(second);
  try {
    const preview = await f.store.read(f.account.id);
    const results = await Promise.all([f.store.begin(f.account.id, preview.revision), b.begin(f.account.id, preview.revision)]);
    assert.deepEqual(results.map(r => r.status), ["started", "conflict"]);
    const lease = (results[0] as { lease: RemovalLease }).lease;
    assert.equal((await b.read(f.account.id)).enabled, false);
    await b.fail(lease); await b.fail(lease);
    await assert.rejects(b.fail({ ...lease, leaseToken: randomUUID() }), /租约/);
    const retry = await b.begin(f.account.id, (await b.read(f.account.id)).revision); assert.equal(retry.status, "started");
    if (retry.status !== "started") throw new Error("missing retry");
    assert.equal(retry.lease.operationId, lease.operationId); assert.notEqual(retry.lease.leaseToken, lease.leaseToken);
    await assert.rejects(f.store.complete(lease), /租约/); await assert.rejects(f.store.fail(lease), /租约/);
    second.close(); const reopened = new ApplicationDatabase(f.path);
    try {
      const store = new SqliteAccountRemovalStore(reopened), snapshot = await store.read(f.account.id);
      assert.equal(snapshot.state, "pending"); assert.equal(snapshot.enabled, false);
      assert.equal((await store.begin(f.account.id, snapshot.revision)).status, "conflict");
      await store.complete(retry.lease); await store.complete(retry.lease); await store.fail(retry.lease);
      assert.equal((await store.read(f.account.id)).state, "removed");
    } finally { reopened.close(); }
  } finally { if (second.connection.isOpen) second.close(); f.close(); }
});

test("account and execution mutations invalidate confirmation; every non-completed status blocks atomic begin", async () => {
  const f = fixture(); try {
    let before = await f.store.read(f.account.id);
    f.database.transaction(() => f.app.repository.updateAccount({ id: f.account.id, nickname: "新名称", enabled: true, tier: "unknown" }));
    assert.equal((await f.store.begin(f.account.id, before.revision)).status, "conflict");
    for (const status of ["queued", "generating", "failed", "uncertain", "unknown-new", ""]) {
      const id = f.execution(status), snapshot = await f.store.read(f.account.id);
      const result = await f.store.begin(f.account.id, snapshot.revision);
      assert.equal(result.status, "blocked"); if (result.status === "blocked") assert.deepEqual(result.blockingExecutionIds, [id]);
      assert.equal((await f.store.read(f.account.id)).enabled, true);
      f.database.connection.prepare("DELETE FROM executions WHERE id=?").run(id);
    }
    before = await f.store.read(f.account.id); const id = f.execution("completed");
    assert.equal((await f.store.begin(f.account.id, before.revision)).status, "conflict");
    before = await f.store.read(f.account.id); f.database.connection.prepare("UPDATE executions SET remote_reference='changed' WHERE id=?").run(id);
    assert.equal((await f.store.begin(f.account.id, before.revision)).status, "conflict");
    before = await f.store.read(f.account.id); f.database.connection.prepare("DELETE FROM executions WHERE id=?").run(id);
    assert.equal((await f.store.begin(f.account.id, before.revision)).status, "conflict");
    assert.equal((await f.store.read(f.account.id)).state, "present");
  } finally { f.close(); }
});

test("pending/removed gate login and edits plus new or reassigned executions; historical metadata and original references survive", async () => {
  const f = fixture(); try {
    const execution = f.execution("completed"), otherExecution = f.execution("completed", f.other.id), film = randomUUID();
    f.database.connection.prepare("INSERT INTO films VALUES (?,?,?,'synthetic.mp4',1,'old')").run(film, execution, f.tasks[0]!.id);
    const refs = f.database.connection.prepare("SELECT * FROM films").all(), taskRows = f.database.connection.prepare("SELECT * FROM tasks ORDER BY id").all();
    const otherBefore = f.app.repository.getAccount(f.other.id), lease = await f.begin();
    for (const state of ["pending", "removed"]) {
      if (state === "removed") await f.store.complete(lease);
      for (const command of ["accounts.openLogin", "accounts.update"]) {
        const input = command === "accounts.openLogin" ? { id: f.account.id } : { id: f.account.id, nickname: "拒绝", enabled: true, tier: "unknown" };
        const result = await f.app.router.dispatch({ requestId: randomUUID(), command, input }, { trusted: true }); assert.equal(result.ok, false);
      }
      assert.equal(f.opened(), 0);
      assert.throws(() => f.execution("completed"), /prevents dispatch/);
      assert.throws(() => f.database.connection.prepare("UPDATE executions SET account_id=? WHERE id=?").run(f.account.id, otherExecution), /reassignment/);
      assert.throws(() => f.database.connection.prepare("UPDATE executions SET status='queued' WHERE id=?").run(execution), /restart/);
      assert.throws(() => f.database.connection.prepare("UPDATE accounts SET enabled=1 WHERE id=?").run(f.account.id), /enabling/);
      assert.throws(() => f.database.connection.prepare("DELETE FROM accounts WHERE id=?").run(f.account.id), /retains identity/);
      f.database.connection.prepare("UPDATE executions SET remote_reference='retained-reference' WHERE id=?").run(execution);
      assert.equal(f.database.connection.prepare("SELECT account_id FROM executions WHERE id=?").get(execution)!.account_id, f.account.id);
      assert.deepEqual(f.database.connection.prepare("SELECT * FROM films").all(), refs);
      assert.deepEqual(f.database.connection.prepare("SELECT * FROM tasks ORDER BY id").all(), taskRows);
      assert.deepEqual(f.app.repository.getAccount(f.other.id), otherBefore);
      assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, 0);
    }
    assert.equal((await f.app.router.dispatch({ requestId: randomUUID(), command: "accounts.openLogin", input: { id: f.other.id } }, { trusted: true })).ok, true);
    assert.equal(f.opened(), 1);
  } finally { f.close(); }
});

test("failed transactional begin/complete rolls back; pending lease persists after reopen and successful completion is idempotent", async () => {
  const f = fixture(); try {
    f.database.connection.exec("CREATE TRIGGER synthetic_removal_failure BEFORE UPDATE OF state ON account_removal BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    const before = await f.store.read(f.account.id);
    await assert.rejects(f.store.begin(f.account.id, before.revision), /synthetic failure/);
    assert.deepEqual(await f.store.read(f.account.id), before);
    f.database.connection.exec("DROP TRIGGER synthetic_removal_failure;");
    const lease = await f.begin();
    f.database.connection.exec("CREATE TRIGGER synthetic_removal_failure BEFORE UPDATE OF state ON account_removal BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    await assert.rejects(f.store.complete(lease), /synthetic failure/);
    assert.equal((await f.store.read(f.account.id)).state, "pending");
    f.database.connection.exec("DROP TRIGGER synthetic_removal_failure;");
    await f.store.fail(lease); const next = await f.begin(); await f.store.complete(next);
    f.database.close(); const db = new ApplicationDatabase(f.path);
    try {
      const store = new SqliteAccountRemovalStore(db); await store.complete(next); await store.fail(next);
      assert.equal((await store.read(f.account.id)).state, "removed"); assert.equal((await store.read(f.account.id)).enabled, false);
    } finally { db.close(); }
  } finally { f.close(); }
});

test("V6 migration retains original rows and rolls back all V7 DDL if a later migration statement fails", () => {
  for (const fail of [false, true]) {
    const f = fixture(); try {
      f.execution("completed");
      const original = f.database.connection.prepare("SELECT * FROM accounts ORDER BY id").all();
      const executions = f.database.connection.prepare("SELECT * FROM executions").all();
      f.database.connection.exec(removeV7Schema + "PRAGMA user_version=6;");
      if (fail) f.database.connection.exec("CREATE TRIGGER removal_execution_insert AFTER INSERT ON executions BEGIN SELECT 1; END;");
      const schema = f.database.connection.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(); f.database.close();
      if (fail) {
        assert.throws(() => new ApplicationDatabase(f.path), /already exists/);
        const raw = new DatabaseSync(f.path);
        try { assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 6); assert.deepEqual(raw.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(), schema); assert.deepEqual(raw.prepare("SELECT * FROM accounts ORDER BY id").all(), original); }
        finally { raw.close(); }
      } else {
        const db = new ApplicationDatabase(f.path);
        try { assert.equal(db.version, 7); assert.deepEqual(db.connection.prepare("SELECT * FROM accounts ORDER BY id").all(), original); assert.deepEqual(db.connection.prepare("SELECT * FROM executions").all(), executions);
          assert.equal(db.connection.prepare("SELECT COUNT(*) n FROM account_removal WHERE state='present' AND revision=0").get()!.n, 2); }
        finally { db.close(); }
      }
    } finally { f.close(); }
  }
});

test("V7 backup validation and isolated restore retain pending/removed fences without activation or reclaim", async () => {
  const f = fixture(); try {
    const lease = await f.begin();
    const other = await f.store.begin(f.other.id, (await f.store.read(f.other.id)).revision);
    assert.equal(other.status, "started"); if (other.status !== "started") throw new Error("lease missing"); await f.store.complete(other.lease);
    const markers = f.database.connection.prepare("SELECT * FROM account_removal ORDER BY account_id").all();
    const backups = join(f.root, "backups"), output = join(f.root, "restore"); mkdirSync(backups); mkdirSync(output);
    const decode = async (_bytes: Buffer): Promise<{ png: Buffer; width: number; height: number }> => { throw new Error("fixture has no images"); };
    const backup = await new WorkspaceBackup({ database: f.database, mediaDirectory: join(f.live, "media"), applicationVersion: "test", chooseDirectory: async () => backups, decode }).create();
    assert.equal(backup!.databaseVersion, 7); assert.equal((await validateBackupDirectory(backup!.directory, decode)).databaseVersion, 7);
    const restored = await new IsolatedRestore({ currentWorkspace: f.live, decode }).restore(backup!.directory, output);
    const db = new ApplicationDatabase(join(restored.directory, "workspace.sqlite"));
    try {
      assert.deepEqual(db.connection.prepare("SELECT * FROM account_removal ORDER BY account_id").all(), markers);
      const store = new SqliteAccountRemovalStore(db), snapshot = await store.read(f.account.id);
      assert.equal(snapshot.enabled, false); assert.equal((await store.begin(f.account.id, snapshot.revision)).status, "conflict");
      assert.equal((await store.read(f.other.id)).state, "removed");
      assert.equal(db.connection.prepare("SELECT lease_token FROM account_removal WHERE account_id=?").get(f.account.id)!.lease_token, lease.leaseToken);
    } finally { db.close(); }
  } finally { f.close(); }
});
