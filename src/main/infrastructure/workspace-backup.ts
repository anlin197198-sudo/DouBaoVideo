import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ApplicationDatabase } from "./database";
import type { ReferenceDecoder } from "./reference-image-store";
import type { BackupResult } from "../../shared/models";
import { ApplicationError } from "../core/errors";

export interface BackupManifest {
  format: "DouBaoVideo-local-backup"; formatVersion: 1; applicationVersion: string;
  databaseVersion: number; createdAt: string;
  files: { path: string; sha256: string; bytes: number }[];
  excluded: string[]; videoFilesIncluded: false; filmRecordCount: number; privacyNotice: string;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Bounded-memory hashing for databases of arbitrary size and final verification. */
export async function hashBackupFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const before = await stat(path);
  if (!before.isFile()) throw new Error("Backup entry is not a regular file");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk); bytes += chunk.length;
  }
  const after = await stat(path);
  if (bytes !== before.size || bytes !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("Backup entry changed during verification");
  return { sha256: hash.digest("hex"), bytes };
}

/** An allowlist export. Never scans userData, sessions, browser profiles, or logs. */
export class WorkspaceBackup {
  private running = false;
  constructor(private readonly options: {
    database: ApplicationDatabase; mediaDirectory: string; applicationVersion: string;
    chooseDirectory: () => Promise<string | null>; decode: ReferenceDecoder;
    copy?: (source: string, destination: string) => Promise<void>;
    snapshot?: (db: DatabaseSync, destination: string) => Promise<unknown>;
  }) {}

  async create(): Promise<BackupResult | null> {
    if (this.running) throw new ApplicationError("CONFLICT", "备份或目录选择尚未完成，请稍候。");
    this.running = true;
    let temporary: string | undefined, parent: string | undefined;
    try {
      const selected = await this.options.chooseDirectory();
      if (!selected) return null;
      parent = await realpath(selected);
      if (!(await lstat(parent)).isDirectory()) throw new Error("Target is not a directory");
      temporary = await mkdtemp(join(parent, ".DouBaoVideo-backup-"));
      const dbPath = join(temporary, "workspace.sqlite");
      await (this.options.snapshot ?? backup)(this.options.database.connection, dbPath);
      const snapshot = new DatabaseSync(dbPath);
      let rows: Record<string, unknown>[], databaseVersion: number, filmRecordCount: number;
      try {
        // Normalize only the new snapshot to a self-contained file. Opening a WAL
        // snapshot read-only otherwise leaves sidecars outside the manifest.
        snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
        const integrity = snapshot.prepare("PRAGMA integrity_check").all();
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || snapshot.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error("Database integrity validation failed");
        databaseVersion = Number(snapshot.prepare("PRAGMA user_version").get()!.user_version);
        rows = snapshot.prepare("SELECT id,file_name,content_hash,width,height FROM reference_images ORDER BY id").all();
        filmRecordCount = Number(snapshot.prepare("SELECT COUNT(*) AS n FROM films").get()!.n);
      } finally { snapshot.close(); }
      const files: BackupManifest["files"] = [];
      files.push({ path: "workspace.sqlite", ...await hashBackupFile(dbPath) });
      const destinationImages = join(temporary, "media", "references");
      await mkdir(destinationImages, { recursive: true });
      if (rows.length) {
        const media = await lstat(this.options.mediaDirectory);
        const references = await lstat(join(this.options.mediaDirectory, "references"));
        if (!media.isDirectory() || media.isSymbolicLink() || !references.isDirectory() || references.isSymbolicLink())
          throw new ApplicationError("STORAGE_ERROR", "归档图片目录不是有效的本地素材目录，未发布备份。");
      }
      for (const row of rows) {
        const name = String(row.file_name);
        if (!/^[0-9a-f-]{36}\.png$/i.test(name) || name !== `${row.id}.png` || basename(name) !== name)
          throw new ApplicationError("STORAGE_ERROR", "归档图片记录路径无效，未发布备份。请检查素材记录。");
        const source = join(this.options.mediaDirectory, "references", name);
        const metadata = await lstat(source);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 20 * 1024 * 1024)
          throw new ApplicationError("STORAGE_ERROR", "归档图片不是有效文件，未发布备份。");
        const target = join(destinationImages, name);
        await (this.options.copy ?? ((from, to) => copyFile(from, to, constants.COPYFILE_EXCL)))(source, target);
        const bytes = await readFile(target);
        if (digest(bytes) !== row.content_hash) throw new ApplicationError("STORAGE_ERROR", "归档图片损坏或备份期间发生变化，未发布备份。请检查或重新导入图片。");
        const decoded = await this.options.decode(bytes);
        if (decoded.width !== row.width || decoded.height !== row.height)
          throw new ApplicationError("STORAGE_ERROR", "归档图片尺寸与记录不符，未发布备份。");
        files.push({ path: `media/references/${name}`, sha256: digest(bytes), bytes: bytes.length });
      }
      const createdAt = new Date().toISOString();
      const manifest: BackupManifest = { format: "DouBaoVideo-local-backup", formatVersion: 1,
        applicationVersion: this.options.applicationVersion, databaseVersion, createdAt, files,
        excluded: ["application login sessions", "cookies", "application passwords and credentials", "browser profiles", "logs", "video files", "unsaved editor drafts"],
        videoFilesIncluded: false, filmRecordCount, privacyNotice: "Secrets entered into business text are included in the database backup. Store the backup privately." };
      const manifestPath = join(temporary, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
      if (JSON.stringify(JSON.parse(await readFile(manifestPath, "utf8"))) !== JSON.stringify(manifest)) throw new Error("Manifest verification failed");
      // Verify persisted copies, not only source buffers, before publication.
      for (const file of files) {
        const verified = await hashBackupFile(join(temporary, file.path));
        if (verified.sha256 !== file.sha256 || verified.bytes !== file.bytes)
          throw new Error("Backup file verification failed");
      }
      const directory = join(parent, `DouBaoVideo-backup-${createdAt.replace(/[:.]/g, "-")}-${randomUUID()}`);
      await rename(temporary, directory);
      temporary = undefined;
      return { directory, createdAt, databaseVersion, imageCount: rows.length,
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), filmRecordCount };
    } catch (cause) {
      let cleanupFailed = false;
      if (temporary && parent) {
        try {
          // Only our owned, direct child temporary folder may be recursively removed.
          const absolute = resolve(temporary);
          if (dirname(absolute) !== resolve(parent) || !basename(absolute).startsWith(".DouBaoVideo-backup-") || (await lstat(absolute)).isSymbolicLink())
            throw new Error("Unsafe cleanup path");
          await rm(absolute, { recursive: true, force: false });
        } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new ApplicationError("STORAGE_ERROR", "备份失败，临时输出未能完整清理；原工作区和已有备份未修改。请检查目标目录中的 .DouBaoVideo-backup- 临时目录。");
      if (cause instanceof ApplicationError) throw cause;
      throw new ApplicationError("STORAGE_ERROR", "备份未完成，未发布新备份。请检查目标目录空间/权限以及归档图片是否缺失或损坏；原工作区和已有备份未修改。");
    } finally { this.running = false; }
  }
}
