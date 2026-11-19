import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { basename, join } from "node:path";
import type { ReferenceImage } from "../../shared/models";
import { ApplicationError } from "../core/errors";
import type { ApplicationDatabase } from "./database";

export interface DecodedReference {
  png: Uint8Array;
  width: number;
  height: number;
}

export type ReferenceDecoder = (bytes: Buffer) => DecodedReference | Promise<DecodedReference>;
const MAX_BYTES = 20 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromRow(row: Record<string, unknown>): ReferenceImage {
  return {
    id: String(row.id), taskId: String(row.task_id), originalName: String(row.original_name),
    width: Number(row.width), height: Number(row.height), createdAt: String(row.created_at),
  };
}

/** Only user-selected files enter this store. The renderer receives opaque image IDs. */
export class ReferenceImageStore {
  private readonly directory: string;

  constructor(
    private readonly database: ApplicationDatabase,
    mediaDirectory: string,
    private readonly decode: ReferenceDecoder,
  ) {
    this.directory = join(mediaDirectory, "references");
    mkdirSync(this.directory, { recursive: true });
  }

  async importFile(taskId: string, selectedPath: string): Promise<ReferenceImage> {
    if (!this.database.connection.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId))
      throw new ApplicationError("NOT_FOUND", "任务已不存在，请刷新列表。");
    let bytes: Buffer;
    try {
      const stat = statSync(selectedPath);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES)
        throw new ApplicationError("INVALID_INPUT", "请选择 20 MB 以内的 PNG、JPG 或 WebP 静态图片。");
      bytes = readFileSync(selectedPath);
      if (bytes.length > MAX_BYTES) throw new ApplicationError("INVALID_INPUT", "图片超过 20 MB，请选择较小的图片。");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("STORAGE_ERROR", "无法读取所选图片，请检查文件是否存在以及读取权限。");
    }
    const signature = bytes.subarray(0, 12);
    const supported = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || (signature[0] === 255 && signature[1] === 216 && signature[2] === 255)
      || (signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP");
    if (!supported) throw new ApplicationError("INVALID_INPUT", "图片格式不支持，请选择 PNG、JPG 或 WebP 静态图片。");
    let decoded: DecodedReference;
    try { decoded = await this.decode(bytes); }
    catch { throw new ApplicationError("INVALID_INPUT", "图片损坏或无法解码，请更换图片。"); }
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height)
      || decoded.width < 1 || decoded.height < 1 || decoded.width > 8192 || decoded.height > 8192
      || decoded.width * decoded.height > 40000000 || decoded.png.length === 0 || decoded.png.length > MAX_BYTES)
      throw new ApplicationError("INVALID_INPUT", "图片过大或无效，请使用边长不超过 8192 像素、4000 万像素以内的图片。");
    const hash = createHash("sha256").update(decoded.png).digest("hex");
    const existing = this.database.connection.prepare("SELECT * FROM reference_images WHERE task_id = ? AND content_hash = ?")
      .get(taskId, hash);
    if (existing && this.isAvailable(String(existing.id))) return fromRow(existing);
    const id = existing ? String(existing.id) : randomUUID();
    const finalPath = join(this.directory, `${id}.png`);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const image: ReferenceImage = {
      id, taskId, originalName: basename(selectedPath).slice(0, 240),
      width: decoded.width, height: decoded.height, createdAt: new Date().toISOString(),
    };
    let renamed = false;
    try {
      writeFileSync(temporary, decoded.png, { flag: "wx" });
      renameSync(temporary, finalPath);
      renamed = true;
      if (!existing) this.database.transaction(() => {
        this.database.connection.prepare("INSERT INTO reference_images VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, taskId, image.originalName, `${id}.png`, hash, image.width, image.height, image.createdAt);
      });
      return existing ? fromRow(existing) : image;
    } catch {
      // Never remove a pre-existing record's file during repair.
      for (const file of [temporary, ...(!existing && renamed ? [finalPath] : [])]) {
        try { if (existsSync(file)) unlinkSync(file); } catch { /* An orphan may be safely kept for diagnosis. */ }
      }
      throw new ApplicationError("STORAGE_ERROR", "参考图归档失败，请检查数据目录和可用空间后重试。");
    }
  }

  pathFor(id: string): string | null {
    if (!uuid.test(id)) return null;
    const row = this.database.connection.prepare("SELECT file_name FROM reference_images WHERE id = ?").get(id);
    if (!row || row.file_name !== `${id}.png`) return null;
    const path = join(this.directory, `${id}.png`);
    return existsSync(path) && statSync(path).isFile() ? path : null;
  }

  /** Return the SAME bounded bytes whose hash matches the decoded import, never an unchecked path. */
  readVerifiedBytes(id: string): Buffer | null {
    if (!uuid.test(id)) return null;
    const row = this.database.connection.prepare("SELECT file_name,content_hash FROM reference_images WHERE id=?").get(id);
    if (!row || row.file_name !== `${id}.png`) return null;
    let fd: number | undefined;
    try {
      fd = openSync(join(this.directory, `${id}.png`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = fstatSync(fd);
      if (!before.isFile() || before.size <= 0 || before.size > MAX_BYTES) return null;
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) return null;
        offset += count;
      }
      // Reject growth without allocating or reading an unbounded file.
      if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) return null;
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
      return createHash("sha256").update(bytes).digest("hex") === row.content_hash ? bytes : null;
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  isAvailable(id: string): boolean { return this.readVerifiedBytes(id) !== null; }
}
