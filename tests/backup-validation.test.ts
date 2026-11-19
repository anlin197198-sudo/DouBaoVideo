import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { WorkspaceBackup, hashBackupFile } from "../src/main/infrastructure/workspace-backup";
import { BackupValidation, validateBackupDirectory } from "../src/main/infrastructure/backup-validation";

const decode = async (bytes: Buffer) => {
  const image = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
  return { png: image.data, width: image.info.width, height: image.info.height };
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doubao-verify-test-"));
  const media = join(root, "media"), output = join(root, "output"); mkdirSync(media); mkdirSync(output);
  const database = new ApplicationDatabase(join(root, "live.sqlite"));
  const repository = new WorkspaceRepository(database);
  const task = database.transaction(() => repository.createPlan({ title: "验证", style: "comic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" })).tasks[0]!;
  const input = join(root, "test.png"); writeFileSync(input, await sharp({ create: { width: 9, height: 7, channels: 3, background: "#345678" } }).png().toBuffer());
  const image = await new ReferenceImageStore(database, media, decode).importFile(task.id, input);
  const result = await new WorkspaceBackup({ database, mediaDirectory: media, applicationVersion: "test", decode, chooseDirectory: async () => output }).create();
  assert.ok(result);
  return { root, database, directory: result.directory, image, task,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}
function changeManifest(directory: string, change: (value: any) => void) {
  const path = join(directory, "manifest.json"); const data = JSON.parse(readFileSync(path, "utf8")); change(data); writeFileSync(path, JSON.stringify(data));
}
async function mutateDatabase(directory: string, sql: string) {
  const path = join(directory, "workspace.sqlite"), db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
  const hash = await hashBackupFile(path);
  changeManifest(directory, manifest => Object.assign(manifest.files.find((file: any) => file.path === "workspace.sqlite"), hash));
}

test("valid backup checks semantic workspaces without changing source bytes or adding sqlite sidecars", async () => {
  const f = await fixture();
  try {
    const before = await hashBackupFile(join(f.directory, "workspace.sqlite"));
    const manifest = readFileSync(join(f.directory, "manifest.json"));
    const verified = await validateBackupDirectory(f.directory, decode);
    assert.equal(verified.taskCount, 7); assert.equal(verified.imageCount, 1);
    assert.deepEqual(await hashBackupFile(join(f.directory, "workspace.sqlite")), before);
    assert.deepEqual(readFileSync(join(f.directory, "manifest.json")), manifest);
    assert.deepEqual(readdirSync(f.directory).sort(), ["manifest.json", "media", "workspace.sqlite"]);
  } finally { f.close(); }
});

test("rejects manifest future versions, traversal, duplicates, omissions and extra files", async () => {
  const f = await fixture();
  try {
    const original = readFileSync(join(f.directory, "manifest.json"));
    for (const change of [
      (m: any) => { m.formatVersion = 2; }, (m: any) => { m.databaseVersion = 6; },
      (m: any) => { m.files[0].path = "../live.sqlite"; }, (m: any) => { m.files[0].path = "C:\\Windows\\file"; },
      (m: any) => { m.files.push(m.files[0]); }, (m: any) => { m.files.pop(); },
      (m: any) => { m.files[0].sha256 = "0".repeat(64); }, (m: any) => { m.files[0].bytes += 1; },
    ]) {
      writeFileSync(join(f.directory, "manifest.json"), original); changeManifest(f.directory, change);
      await assert.rejects(validateBackupDirectory(f.directory, decode), /验证未通过/);
    }
    writeFileSync(join(f.directory, "manifest.json"), original);
    for (const name of ["workspace.sqlite-wal", "extra.txt"]) {
      writeFileSync(join(f.directory, name), "extra");
      await assert.rejects(validateBackupDirectory(f.directory, decode), /多余/);
      rmSync(join(f.directory, name));
    }
    writeFileSync(join(f.directory, "media", "references", "extra.png"), "extra");
    await assert.rejects(validateBackupDirectory(f.directory, decode), /清单不一致/);
  } finally { f.close(); }
});

test("rejects untrusted schema objects before reading business tables even if hashes were recomputed", async () => {
  for (const sql of [
    "CREATE TRIGGER untrusted AFTER UPDATE ON plans BEGIN SELECT load_extension('evil'); END;",
    "CREATE VIEW untrusted AS SELECT load_extension('evil');",
    "DROP TABLE reference_images; CREATE VIEW reference_images AS SELECT load_extension('evil') AS id;",
  ]) {
    const f = await fixture();
    try {
      await mutateDatabase(f.directory, sql);
      await assert.rejects(validateBackupDirectory(f.directory, decode), /结构/);
    } finally { f.close(); }
  }
});

test("rejects foreign-key corruption, malformed workspaces and inconsistent picture dimensions despite matching file hashes", async () => {
  for (const sql of [
    "PRAGMA foreign_keys=OFF; UPDATE tasks SET plan_id='missing';",
    "UPDATE tasks SET workspace_json='{broken';",
    "UPDATE tasks SET workspace_json='{}';",
    "UPDATE reference_images SET width=300;",
    "UPDATE reference_images SET content_hash='false';",
  ]) {
    const f = await fixture();
    try { await mutateDatabase(f.directory, sql); await assert.rejects(validateBackupDirectory(f.directory, decode), /验证未通过/); }
    finally { f.close(); }
  }
});

test("rejects changed bytes or directory entries arriving during verification", async () => {
  const f = await fixture();
  try {
    await assert.rejects(validateBackupDirectory(f.directory, async bytes => {
      writeFileSync(join(f.directory, "late.txt"), "late");
      return decode(bytes);
    }), /期间目录内容变化/);
  } finally { f.close(); }
});

test("directory chooser cancellation is read-only and overlapping verification attempts reject", async () => {
  const verifier = new BackupValidation(async () => null, decode);
  assert.equal(await verifier.verify(), null);
  let release!: (path: null) => void;
  const gate = new Promise<null>(resolve => { release = resolve; });
  const other = new BackupValidation(() => gate, decode);
  const active = other.verify();
  await assert.rejects(other.verify(), /尚未|先完成/);
  release(null); assert.equal(await active, null);
});

test("backup root junction is rejected without reading through or modifying its target", async context => {
  const f = await fixture();
  try {
    const link = join(f.root, "linked-backup");
    try { symlinkSync(f.directory, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && ["EPERM", "EACCES", "ENOTSUP"].includes(String(cause.code))) { context.skip("Platform does not permit links"); return; }
      throw cause;
    }
    await assert.rejects(validateBackupDirectory(link, decode), /junction/);
    assert.equal((await validateBackupDirectory(f.directory, decode)).imageCount, 1);
  } finally { f.close(); }
});

test("historical V3 and V4 backups stay read-only verifiable after V5 upgrade", async () => {
  for (const version of [3, 4]) {
    const f = await fixture();
    try {
      await mutateDatabase(f.directory, "DROP TABLE prompt_history; " + (version === 3 ? "ALTER TABLE plans DROP COLUMN style_notes; " : "") + "PRAGMA user_version=" + version + ";");
      changeManifest(f.directory, manifest => { manifest.databaseVersion = version; });
      const before = await hashBackupFile(join(f.directory, "workspace.sqlite"));
      const result = await validateBackupDirectory(f.directory, decode);
      assert.equal(result.databaseVersion, version); assert.equal(result.taskCount, 7);
      assert.deepEqual(await hashBackupFile(join(f.directory, "workspace.sqlite")), before);
      assert.deepEqual(readdirSync(f.directory).sort(), ["manifest.json", "media", "workspace.sqlite"]);
    } finally { f.close(); }
  }
});
