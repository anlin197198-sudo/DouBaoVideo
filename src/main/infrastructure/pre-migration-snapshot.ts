import { backup, DatabaseSync } from "node:sqlite";
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ApplicationDatabase, CURRENT_DATABASE_VERSION, trustedDatabaseSchema } from "./database";
import { hashBackupFile } from "./workspace-backup";

const name = "workspace.sqlite";
const sidecars = ["-wal", "-shm", "-journal"];
const originalTables = ["plans", "tasks", "accounts", "executions", "films", "command_receipts"];
const inventory = (db: DatabaseSync, tables: readonly string[]) => JSON.stringify(tables.map(table =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n));
const versionOf = (db: DatabaseSync) => Number(db.prepare("PRAGMA user_version").get()?.user_version);
const dataVersion = (db: DatabaseSync) => Number(db.prepare("PRAGMA data_version").get()?.data_version);
const schema = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all());

function statIfPresent(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}
function assertSidecars(path: string, allowRegular: boolean): void {
  for (const suffix of sidecars) {
    const stat = statIfPresent(path + suffix);
    if (stat && (!allowRegular || !stat.isFile() || stat.nlink !== 1)) throw new Error("Unexpected SQLite sidecar");
  }
}
function identity(path: string, directory = false): string {
  const stat = lstatSync(path, { bigint: true });
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) throw new Error("Unexpected object");
  return `${stat.dev}:${stat.ino}`;
}
function checkIntegrity(db: DatabaseSync): void {
  const check = db.prepare("PRAGMA integrity_check").all();
  if (check.length !== 1 || check[0]?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("Database integrity check failed");
  }
}

/** Electron startup only: called after the application's single-instance lock.
 * Workspace parent must be private, app-owned, with no external writer during upgrade.
 * The injectable backup is internal, only for deterministic failure tests.
 */
export async function openWorkspaceWithSafetyCopy(
  databasePath: string, snapshot: (reader: DatabaseSync, destination: string) => Promise<unknown> = backup,
): Promise<ApplicationDatabase> {
  let retained = false;
  let migrationStarted = false;
  try {
    if (basename(databasePath) !== name) throw new Error("Unexpected database name");
    const parent = realpathSync(dirname(resolve(databasePath)));
    const source = join(parent, name);
    const sourceStat = statIfPresent(source);
    assertSidecars(source, sourceStat !== null);
    if (!sourceStat) return new ApplicationDatabase(source);
    const parentId = identity(parent, true), sourceId = identity(source);
    const reader = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    let oldCore: string;
    let coreTables: string[];
    try {
      const oldVersion = versionOf(reader);
      if (oldVersion !== 1 && oldVersion !== 2 && oldVersion !== 3 && oldVersion !== 4 && oldVersion !== 5 && oldVersion !== 6 &&
        oldVersion !== CURRENT_DATABASE_VERSION) {
        throw new Error("Unsupported existing version");
      }
      if (schema(reader) !== trustedDatabaseSchema(oldVersion)) throw new Error("Unexpected workspace schema");
      if (oldVersion === CURRENT_DATABASE_VERSION) return new ApplicationDatabase(source);

      const observed = dataVersion(reader);
      checkIntegrity(reader);
      coreTables = oldVersion === 1 ? originalTables : [...originalTables, "reference_images"];
      oldCore = inventory(reader, coreTables);
      const tables = [...coreTables, ...(oldVersion >= 5 ? ["prompt_history"] : []), ...(oldVersion >= 6 ? ["script_history"] : [])];
      const before = inventory(reader, tables);
      const parentOfCopies = join(parent, "upgrade-backups");
      try { mkdirSync(parentOfCopies, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const copiesId = identity(parentOfCopies, true);
      if (realpathSync(parentOfCopies) !== parentOfCopies) throw new Error("Redirected snapshot directory");
      const child = mkdtempSync(join(parentOfCopies, `before-v${oldVersion}-`));
      const childId = identity(child, true);
      const copy = join(child, name);
      const destination = openSync(copy, "wx", 0o600);
      closeSync(destination);
      const copyId = identity(copy);
      await snapshot(reader, copy);
      const sameCopy = () => identity(parentOfCopies, true) === copiesId && identity(child, true) === childId && identity(copy) === copyId;
      if (!sameCopy()) throw new Error("Snapshot replaced");
      assertSidecars(copy, true);
      const writer = new DatabaseSync(copy, { timeout: 5000 });
      try {
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        if (writer.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new Error("Snapshot not standalone");
      } finally { writer.close(); }
      assertSidecars(copy, false);
      const verified = new DatabaseSync(copy, { readOnly: true });
      try {
        checkIntegrity(verified);
        if (versionOf(verified) !== oldVersion || schema(verified) !== schema(reader) || inventory(verified, tables) !== before) {
          throw new Error("Snapshot does not match original schema and key record counts");
        }
      } finally { verified.close(); }
      const syncFile = openSync(copy, "r+");
      try { fsyncSync(syncFile); } finally { closeSync(syncFile); }
      const fingerprint = await hashBackupFile(copy);
      if (!sameCopy() || identity(parent, true) !== parentId || identity(source) !== sourceId ||
        dataVersion(reader) !== observed || versionOf(reader) !== oldVersion) throw new Error("Workspace changed during backup");
      assertSidecars(source, true);
      const marker = openSync(join(child, "verified.json"), "wx", 0o600);
      try {
        writeFileSync(marker, JSON.stringify({ database: name, version: oldVersion, ...fingerprint }) + "\n");
        fsyncSync(marker);
      } finally { closeSync(marker); }
      retained = true;
    } finally { reader.close(); }

    migrationStarted = true;
    const database = new ApplicationDatabase(source);
    try {
      if (database.version !== CURRENT_DATABASE_VERSION || schema(database.connection) !== trustedDatabaseSchema(CURRENT_DATABASE_VERSION) ||
        inventory(database.connection, coreTables) !== oldCore ||
        (coreTables === originalTables && inventory(database.connection, ["reference_images"]) !== "[0]")) {
        throw new Error("Post-upgrade verification failed");
      }
      checkIntegrity(database.connection);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  } catch {
    if (!migrationStarted) throw new Error("未启动数据库升级：无法验证现有工作区或保留升级前副本。请勿使用未验证的副本。");
    if (retained) throw new Error("数据库升级或升级后检查失败。已保留升级前验证副本；请勿覆盖当前工作区，也未自动恢复。");
    throw new Error("无法初始化本地工作区。");
  }
}
