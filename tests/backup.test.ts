import assert from "node:assert/strict";
import { test } from "node:test";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync, renameSync, symlinkSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { WorkspaceBackup, hashBackupFile, type BackupManifest } from "../src/main/infrastructure/workspace-backup";

const decode = async (bytes: Buffer) => {
  const result = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
  return { png: result.data, width: result.info.width, height: result.info.height };
};

test("streaming backup hash covers multiple chunks with exact byte count and digest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-hash-"));
  try {
    const bytes = Buffer.alloc(3 * 64 * 1024 + 137);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const file = join(directory, "stream.bin"); writeFileSync(file, bytes);
    assert.deepEqual(await hashBackupFile(file), { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    writeFileSync(file, Buffer.alloc(0));
    assert.deepEqual(await hashBackupFile(file), { bytes: 0, sha256: createHash("sha256").digest("hex") });
    await assert.rejects(hashBackupFile(join(directory, "missing")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doubao-backup-"));
  const destination = join(root, "output"); mkdirSync(destination);
  const data = join(root, "live"); mkdirSync(data);
  const media = join(data, "media"); mkdirSync(media);
  const database = new ApplicationDatabase(join(data, "workspace.sqlite"));
  const repository = new WorkspaceRepository(database);
  const task = database.transaction(() => repository.createPlan({ title: "备份测试", style: "comic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" })).tasks[0]!;
  const image = join(root, "input.png");
  writeFileSync(image, await sharp({ create: { width: 8, height: 6, channels: 3, background: "#345678" } }).png().toBuffer());
  const store = new ReferenceImageStore(database, media, decode);
  const reference = await store.importFile(task.id, image);
  mkdirSync(join(data, "Partitions")); writeFileSync(join(data, "Partitions", "secret-cookie"), "never copy");
  const options = { database, mediaDirectory: media, applicationVersion: "test", chooseDirectory: async () => destination, decode };
  return { root, destination, data, media, database, repository, task, reference, options,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("consistent WAL snapshot and exact static images validate, omit sessions, and reopen independently of original files", async () => {
  const f = await fixture();
  try {
    f.database.transaction(() => f.repository.saveWorkspace({ id: f.task.id, expectedRevision: 0, workspace: { ...f.task.workspace, script: "snapshot content" } }));
    const exporter = new WorkspaceBackup({ ...f.options, copy: async (source, target) => {
      // A later live edit must not change the already finished snapshot.
      const current = f.repository.getTask(f.task.id);
      f.database.transaction(() => f.repository.saveWorkspace({ id: current.id, expectedRevision: current.revision, workspace: { ...current.workspace, script: "new live content" } }));
      await copyFile(source, target);
    } });
    const result = await exporter.create(); assert.ok(result);
    assert.deepEqual(readdirSync(result.directory).sort(), ["manifest.json", "media", "workspace.sqlite"]);
    const manifest = JSON.parse(readFileSync(join(result.directory, "manifest.json"), "utf8")) as BackupManifest;
    assert.equal(manifest.databaseVersion, 5); assert.equal(manifest.files.length, 2);
    assert.equal(manifest.videoFilesIncluded, false);
    assert.equal(existsSync(join(result.directory, "Partitions")), false);
    for (const file of manifest.files) assert.equal(createHash("sha256").update(readFileSync(join(result.directory, file.path))).digest("hex"), file.sha256);
    const restored = new ApplicationDatabase(join(result.directory, "workspace.sqlite"));
    try {
      assert.equal(new WorkspaceRepository(restored).getTask(f.task.id).workspace.script, "snapshot content");
      rmSync(join(f.media, "references", `${f.reference.id}.png`));
      const store = new ReferenceImageStore(restored, join(result.directory, "media"), decode);
      assert.equal(store.isAvailable(f.reference.id), true);
    } finally { restored.close(); }
    assert.equal(f.repository.getTask(f.task.id).workspace.script, "new live content");
  } finally { f.close(); }
});

test("cancel produces no output; overlapping attempts reject and successful repeated backups never overwrite", async () => {
  const f = await fixture();
  try {
    assert.equal(await new WorkspaceBackup({ ...f.options, chooseDirectory: async () => null }).create(), null);
    assert.deepEqual(readdirSync(f.destination), []);
    let release!: (path: string) => void;
    const selected = new Promise<string>(resolve => { release = resolve; });
    const exporter = new WorkspaceBackup({ ...f.options, chooseDirectory: () => selected });
    const pending = exporter.create();
    await assert.rejects(exporter.create(), /尚未完成/);
    release(f.destination);
    const first = await pending, second = await exporter.create();
    assert.ok(first && second); assert.notEqual(first.directory, second.directory);
    assert.equal(readdirSync(f.destination).length, 2);
  } finally { f.close(); }
});

test("missing/corrupt images and snapshot/copy errors publish nothing and clean only their temporary output", async () => {
  const f = await fixture();
  try {
    const untouched = join(f.destination, "existing-backup"); mkdirSync(untouched); writeFileSync(join(untouched, "keep"), "keep");
    for (const overrides of [
      { snapshot: async () => { throw new Error("disk full"); } },
      { copy: async () => { throw new Error("write denied"); } },
      { copy: async (_source: string, target: string) => { writeFileSync(target, "broken"); } },
    ]) {
      await assert.rejects(new WorkspaceBackup({ ...f.options, ...overrides }).create(), /未完成|损坏/);
      assert.deepEqual(readdirSync(f.destination), ["existing-backup"]);
    }
    const source = join(f.media, "references", `${f.reference.id}.png`);
    rmSync(source);
    await assert.rejects(new WorkspaceBackup(f.options).create(), /未完成/);
    assert.deepEqual(readdirSync(f.destination), ["existing-backup"]);
    assert.equal(readFileSync(join(untouched, "keep"), "utf8"), "keep");
  } finally { f.close(); }
});

test("polluted image paths and invalid database snapshots are refused before publication", async () => {
  const f = await fixture();
  try {
    f.database.connection.prepare("UPDATE reference_images SET file_name='../Partitions/secret-cookie'").run();
    await assert.rejects(new WorkspaceBackup(f.options).create(), /路径无效/);
    assert.deepEqual(readdirSync(f.destination), []);
    await assert.rejects(new WorkspaceBackup({ ...f.options, snapshot: async (_db, destination) => { writeFileSync(destination, "not sqlite"); } }).create(), /未完成/);
    assert.deepEqual(readdirSync(f.destination), []);
  } finally { f.close(); }
});

test("backup enumerates only its own snapshot image list even when new live images arrive later", async () => {
  const f = await fixture();
  try {
    const exporter = new WorkspaceBackup({ ...f.options, snapshot: async (source, destination) => {
      await backup(source, destination);
      f.database.connection.prepare("INSERT INTO reference_images VALUES (?,?,? ,?,'missing',1,1,'now')").run(randomUUID(), f.task.id, "later.png", `${randomUUID()}.png`);
    } });
    const result = await exporter.create(); assert.ok(result);
    assert.equal(result.imageCount, 1);
    const snapshot = new DatabaseSync(join(result.directory, "workspace.sqlite"), { readOnly: true });
    try { assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM reference_images").get()!.n, 1); }
    finally { snapshot.close(); }
  } finally { f.close(); }
});

test("a references-directory junction or symlink cannot export files through redirected paths", async context => {
  const f = await fixture();
  try {
    const original = join(f.media, "references"), moved = join(f.media, "original-references");
    renameSync(original, moved);
    try { symlinkSync(moved, original, process.platform === "win32" ? "junction" : "dir"); }
    catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && ["EPERM", "EACCES", "ENOTSUP"].includes(String(cause.code))) {
        context.skip("Platform does not permit creating test junctions/symlinks"); return;
      }
      throw cause;
    }
    await assert.rejects(new WorkspaceBackup(f.options).create(), /素材目录/);
    assert.deepEqual(readdirSync(f.destination), []);
    assert.equal(existsSync(join(moved, `${f.reference.id}.png`)), true);
  } finally { f.close(); }
});
