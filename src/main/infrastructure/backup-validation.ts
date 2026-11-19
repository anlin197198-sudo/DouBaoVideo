import { DatabaseSync } from "node:sqlite";
import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { trustedDatabaseSchema } from "./database";
import { hashBackupFile } from "./workspace-backup";
import type { ReferenceDecoder } from "./reference-image-store";
import type { BackupValidationResult } from "../../shared/models";
import { commandSchemas } from "../../shared/validation";
import { ApplicationError } from "../core/errors";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const imagePath = new RegExp(`^media/references/${uuid}\\.png$`, "i");
const manifestSchema = z.object({
  format: z.literal("DouBaoVideo-local-backup"), formatVersion: z.literal(1),
  applicationVersion: z.string().min(1).max(100), databaseVersion: z.union([z.literal(3), z.literal(4), z.literal(5)]), createdAt: z.iso.datetime(),
  files: z.array(z.object({ path: z.string().refine(path => path === "workspace.sqlite" || imagePath.test(path)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(100000),
  excluded: z.array(z.string().max(200)).max(30), videoFilesIncluded: z.literal(false),
  filmRecordCount: z.number().int().nonnegative(), privacyNotice: z.string().max(1000).optional(),
}).strict();

function fail(message: string): never { throw new ApplicationError("INVALID_INPUT", `备份验证未通过：${message}。未修改原备份或当前工作区。`); }
async function ordinary(path: string, directory: boolean): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) fail("发现链接、junction 或不支持的文件类型");
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(await realpath(path)) !== normalize(resolve(path))) fail("路径经过链接或 junction，无法安全验证");
}
function sameNames(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    size += chunk.length;
    if (size > maximum) fail("文件在读取期间超过安全大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
function schemaRows(database: DatabaseSync) {
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
}
const trustedSchemas = new Map<number, string>();
function knownSchema(version: 3 | 4 | 5): string {
  if (!trustedSchemas.has(version)) trustedSchemas.set(version, trustedDatabaseSchema(version));
  return trustedSchemas.get(version)!;
}

/** Reads an allowlisted backup; SQLite only opens an isolated, disposable copy. */
export async function validateBackupDirectory(selected: string, decode: ReferenceDecoder): Promise<BackupValidationResult> {
  let temporary: string | undefined;
  try {
    await ordinary(selected, true);
    const root = await realpath(selected);
    if (!sameNames(await readdir(root), ["manifest.json", "workspace.sqlite", "media"])) fail("根目录存在遗漏或多余文件");
    await ordinary(join(root, "manifest.json"), false);
    if ((await lstat(join(root, "manifest.json"))).size > 8 * 1024 * 1024) fail("清单超过安全大小限制");
    const manifestBytes = await boundedRead(join(root, "manifest.json"), 8 * 1024 * 1024);
    const parsed = manifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")));
    if (!parsed.success) fail("清单格式、版本或文件路径不受支持（仅支持本应用 V3／V4／V5 数据库备份）");
    const manifest = parsed.data;
    const names = manifest.files.map(file => file.path);
    if (new Set(names.map(path => path.toLowerCase())).size !== names.length || names.filter(name => name === "workspace.sqlite").length !== 1)
      fail("清单重复或缺少数据库");
    await ordinary(join(root, "media"), true);
    if (!sameNames(await readdir(join(root, "media")), ["references"])) fail("素材目录存在遗漏或多余内容");
    await ordinary(join(root, "media", "references"), true);
    const images = manifest.files.filter(file => imagePath.test(file.path));
    const imageFiles = new Map(images.map(file => [file.path, file]));
    if (!sameNames(await readdir(join(root, "media", "references")), images.map(file => basename(file.path)))) fail("图片文件与清单不一致");
    for (const file of manifest.files) {
      await ordinary(join(root, file.path), false);
      if (file.path !== "workspace.sqlite" && (file.bytes <= 0 || file.bytes > 20 * 1024 * 1024)) fail("图片超过安全大小限制");
      const actual = await hashBackupFile(join(root, file.path));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) fail("文件大小或 SHA-256 不匹配");
    }
    temporary = await mkdtemp(join(tmpdir(), "DouBaoVideo-verify-"));
    const isolated = join(temporary, "workspace.sqlite");
    await copyFile(join(root, "workspace.sqlite"), isolated, constants.COPYFILE_EXCL);
    const dbFile = manifest.files.find(file => file.path === "workspace.sqlite")!;
    if ((await hashBackupFile(isolated)).sha256 !== dbFile.sha256) fail("数据库在复制期间变化");
    const database = new DatabaseSync(isolated, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });
    let taskCount = 0, filmRecordCount = 0;
    try {
      database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
      // Only system metadata is read until every schema object matches trusted app DDL.
      if (JSON.stringify(schemaRows(database)) !== knownSchema(manifest.databaseVersion)) fail("数据库结构与对应版本的可信结构不一致");
      if (database.prepare("PRAGMA user_version").get()!.user_version !== manifest.databaseVersion) fail("数据库版本与清单不一致");
      const integrity = database.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) fail("数据库完整性或外键检查失败");
      const records = database.prepare("SELECT id,task_id,file_name,content_hash,width,height FROM reference_images ORDER BY id").all();
      const imagesById = new Map(records.map(record => [String(record.id), record]));
      if (records.length !== images.length) fail("数据库图片数量与清单不一致");
      for (const row of records) {
        const path = `media/references/${String(row.file_name)}`;
        const file = imageFiles.get(path);
        if (!file || row.file_name !== `${row.id}.png` || row.content_hash !== file.sha256) fail("数据库图片来源或 hash 与清单不一致");
        await ordinary(join(root, path), false);
        if ((await lstat(join(root, path))).size > 20 * 1024 * 1024) fail("图片读取前超过大小限制");
        const bytes = await boundedRead(join(root, path), 20 * 1024 * 1024);
        if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) fail("图片在解码前变化");
        const decoded = await decode(bytes);
        if (decoded.width !== row.width || decoded.height !== row.height) fail("图片解码尺寸与数据库不一致");
      }
      for (const row of database.prepare("SELECT id,workspace_json FROM tasks").iterate()) {
        const parsed = commandSchemas["tasks.saveWorkspace"].shape.workspace.safeParse(JSON.parse(String(row.workspace_json)));
        if (!parsed.success) fail("任务制作内容格式无效");
        const referenced = [...parsed.data.assets.map(asset => asset.referenceImageId).filter(Boolean), ...(parsed.data.frames?.candidates.map(candidate => candidate.imageId) ?? [])];
        if (referenced.some(id => !id || imagesById.get(id)?.task_id !== row.id)) fail("任务引用缺失或跨任务图片");
        taskCount++;
      }
      filmRecordCount = Number(database.prepare("SELECT COUNT(*) AS n FROM films").get()!.n);
      if (filmRecordCount !== manifest.filmRecordCount) fail("成片元数据数量与清单不一致");
    } finally { database.close(); }
    // A successful report describes the selected bytes, not a file changed mid-check.
    await ordinary(root, true); await ordinary(join(root, "media"), true); await ordinary(join(root, "media", "references"), true);
    if (!sameNames(await readdir(root), ["manifest.json", "workspace.sqlite", "media"])
      || !sameNames(await readdir(join(root, "media")), ["references"])
      || !sameNames(await readdir(join(root, "media", "references")), images.map(file => basename(file.path)))) fail("验证期间目录内容变化");
    await ordinary(join(root, "manifest.json"), false);
    if (!manifestBytes.equals(await boundedRead(join(root, "manifest.json"), 8 * 1024 * 1024))) fail("验证期间清单变化");
    for (const file of manifest.files) {
      await ordinary(join(root, file.path), false);
      const actual = await hashBackupFile(join(root, file.path));
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) fail("验证期间文件变化");
    }
    return { directory: root, createdAt: manifest.createdAt, databaseVersion: manifest.databaseVersion, imageCount: images.length,
      taskCount, filmRecordCount, totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    throw new ApplicationError("INVALID_INPUT", "备份验证未通过：文件缺失、无法读取、格式损坏或图片不可解码。未修改原备份或当前工作区。");
  } finally {
    if (temporary) {
      const path = resolve(temporary);
      if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("DouBaoVideo-verify-") || (await lstat(path)).isSymbolicLink())
        throw new ApplicationError("STORAGE_ERROR", "验证临时目录无法安全清理；原备份和当前工作区未修改。");
      try { await rm(path, { recursive: true, force: false }); }
      catch { throw new ApplicationError("STORAGE_ERROR", "验证临时副本清理失败，请检查系统临时目录；原备份和当前工作区未修改。"); }
    }
  }
}

export class BackupValidation {
  private running = false;
  constructor(private readonly choose: () => Promise<string | null>, private readonly decode: ReferenceDecoder) {}
  async verify(): Promise<BackupValidationResult | null> {
    if (this.running) throw new ApplicationError("CONFLICT", "请先完成当前备份验证或目录选择。");
    this.running = true;
    try { const directory = await this.choose(); return directory ? await validateBackupDirectory(directory, this.decode) : null; }
    finally { this.running = false; }
  }
}
