import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { trustedDatabaseSchema } from "../src/main/infrastructure/database";
import { openWorkspaceWithSafetyCopy } from "../src/main/infrastructure/pre-migration-snapshot";
import { hashBackupFile } from "../src/main/infrastructure/workspace-backup";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "doubao-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "workspace.sqlite"), copies: join(root, "upgrade-backups") };
}
function seed(path: string, version: 1 | 2 | 3 | 4 | 5 | 6, script: string | null = "合成文本") {
  const db = new DatabaseSync(path);
  try {
    const rows = JSON.parse(trustedDatabaseSchema(version)) as { type: string; sql: string | null }[];
    for (const type of ["table", "index", "trigger"]) for (const row of rows) if (row.type === type && row.sql) db.exec(row.sql);
    db.exec(`PRAGMA user_version=${version}`);
    db.exec("INSERT INTO plans (id,title,style,start_date,daily_count,execution_time,enabled,created_at) VALUES ('p','t','3d','2026-11-20',1,'10:00',1,'t')");
    db.prepare("INSERT INTO tasks (id,plan_id,title,business_date,sequence,workspace_json,updated_at) VALUES ('t','p','t','2026-11-20',1,?,'t')")
      .run(JSON.stringify({script, prompts: []}));
  } finally { db.close(); }
}
async function copyLocation(copies: string) {
  const entries = await readdir(copies);
  assert.equal(entries.length, 1);
  const child = join(copies, entries[0]!);
  return { child, copy: join(child, "workspace.sqlite") };
}
function readVersion(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("PRAGMA user_version").get()?.user_version; }
  finally { db.close(); }
}

for (const version of [1, 2, 3, 4, 5, 6] as const) test(`V${version}: preserves a standalone verified snapshot and does not duplicate after successful upgrade`, async t => {
  const { path, copies } = await fixture(t);
  seed(path, version);
  const upgraded = await openWorkspaceWithSafetyCopy(path);
  try {
    assert.equal(upgraded.version, 7);
    assert.equal(upgraded.connection.prepare("SELECT title FROM tasks").get()?.title, "t");
  } finally { upgraded.close(); }
  const { child, copy } = await copyLocation(copies);
  assert.deepEqual((await readdir(child)).sort(), ["verified.json", "workspace.sqlite"]);
  assert.equal(readVersion(copy), version);
  assert.deepEqual(JSON.parse(await readFile(join(child, "verified.json"), "utf8")), {database:"workspace.sqlite",version,...await hashBackupFile(copy)});
  (await openWorkspaceWithSafetyCopy(path, async () => { assert.fail("already current"); })).close();
  assert.equal((await readdir(copies)).length, 1);
});

test("online snapshot retains a committed WAL-only record, without requiring source checkpoint", async t => {
  const { path, copies } = await fixture(t);
  seed(path, 6);
  const writer = new DatabaseSync(path);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE tasks SET title='WAL-only';");
    assert.ok((await readFile(path + "-wal")).length > 32);
    (await openWorkspaceWithSafetyCopy(path)).close();
    const { copy } = await copyLocation(copies);
    const copied = new DatabaseSync(copy, { readOnly: true });
    try { assert.equal(copied.prepare("SELECT title FROM tasks").get()?.title, "WAL-only"); }
    finally { copied.close(); }
  } finally { writer.close(); }
});

test("late migration failure keeps the verified original version without auto-restoring it", async t => {
  const { path, copies } = await fixture(t);
  seed(path, 4, null);
  await assert.rejects(openWorkspaceWithSafetyCopy(path), /已保留升级前验证副本/);
  assert.equal(readVersion(path), 5);
  const { child, copy } = await copyLocation(copies);
  assert.equal(readVersion(copy), 4);
  assert.deepEqual(JSON.parse(await readFile(join(child, "verified.json"), "utf8")), {database:"workspace.sqlite",version:4,...await hashBackupFile(copy)});
});

test("failed copy, mismatched counts and concurrent commit fail closed and do not emit a verification marker", async t => {
  for (const failure of ["copy", "counts", "source"] as const) {
    const { path, copies } = await fixture(t);
    seed(path, 6);
    await assert.rejects(openWorkspaceWithSafetyCopy(path, async (reader, destination) => {
      if (failure === "copy") throw new Error("SYNTHETIC_PRIVATE_PATH");
      const result = await backup(reader, destination);
      const writer = new DatabaseSync(failure === "source" ? path : destination);
      try { writer.exec(failure === "source" ? "UPDATE tasks SET title='new commit'" : "DELETE FROM tasks"); }
      finally { writer.close(); }
      return result;
    }), error => error instanceof Error && /未启动数据库升级/.test(error.message) && !error.message.includes("SYNTHETIC_PRIVATE_PATH"));
    assert.equal(readVersion(path), 6);
    assert.ok(!(await readdir((await copyLocation(copies)).child)).includes("verified.json"));
  }
});

test("fresh/current start without a copy; unknown, future, wrong schema and redirected files cannot upgrade", async t => {
  const fresh = await fixture(t);
  (await openWorkspaceWithSafetyCopy(fresh.path)).close();
  (await openWorkspaceWithSafetyCopy(fresh.path)).close();
  assert.deepEqual(await readdir(fresh.root), ["workspace.sqlite"]);
  for (const version of [0, 1, 2, 6, 8]) {
    const { path, root } = await fixture(t);
    const db = new DatabaseSync(path); db.exec(`PRAGMA user_version=${version}`); db.close();
    // Version zero alone may not write a file on all engines, so assert its presence by explicit header mutation.
    const file = new DatabaseSync(path); file.exec("CREATE TABLE unexpected(id)"); file.close();
    await assert.rejects(openWorkspaceWithSafetyCopy(path), /未启动数据库升级/);
    assert.deepEqual(await readdir(root), ["workspace.sqlite"]);
  }
  const redirected = await fixture(t);
  const target = await fixture(t);
  seed(target.path, 6);
  await symlink(target.root, join(redirected.root, "workspace.sqlite"), "junction");
  await assert.rejects(openWorkspaceWithSafetyCopy(redirected.path), /未启动数据库升级/);
  assert.equal(readVersion(target.path), 6);
});

test("redirected snapshot parent or preexisting marker stops upgrade without overwriting", async t => {
  const one = await fixture(t), other = await fixture(t);
  seed(one.path, 6);
  await symlink(other.root, one.copies, "junction");
  await assert.rejects(openWorkspaceWithSafetyCopy(one.path), /未启动数据库升级/);
  assert.deepEqual(await readdir(other.root), []);
  assert.equal(readVersion(one.path), 6);
  const two = await fixture(t);
  seed(two.path, 6);
  await mkdir(two.copies);
  await assert.rejects(openWorkspaceWithSafetyCopy(two.path, async (reader, destination) => {
    const result = await backup(reader, destination);
    await mkdir(join(destination, "..", "verified.json"));
    return result;
  }), /未启动数据库升级/);
  assert.deepEqual(await readdir(join((await copyLocation(two.copies)).child, "verified.json")), []);
  assert.equal(readVersion(two.path), 6);
});
