import type { IsolatedRestoreResult } from "../../shared/models";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { ReferenceDecoder } from "./reference-image-store";
import { backupManifestSchema, validateBackupDirectory } from "./backup-validation";
import { ApplicationError } from "../core/errors";

const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
function within(parent: string, child: string): boolean {
  const path = relative(normalize(parent), normalize(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
async function ordinary(path: string, directory: boolean) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || normalize(await realpath(path)) !== normalize(resolve(path))) throw new Error("链接或非普通路径不受支持");
  return stat;
}
async function manifestBytes(root: string): Promise<Buffer> {
  const path = join(root, "manifest.json"); const before = await ordinary(path, false);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("清单在打开时变化");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("清单过大"); chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}
/** Pins both the displayed validation result and approval to the same manifest bytes. */
export async function validateRestorePreview(source: string, decode: ReferenceDecoder) {
  const before = await manifestBytes(source);
  const digest = createHash("sha256").update(before).digest("hex");
  const result = await validateBackupDirectory(source, decode);
  if (result.manifestSha256 !== digest || !before.equals(await manifestBytes(source)))
    throw new ApplicationError("CONFLICT", "备份在预览期间变化，请重新选择并确认。");
  return result;
}

function check(signal?: AbortSignal) { if (signal?.aborted) throw new Error("已取消隔离恢复"); }

/** Copies only an already validated manifest entry, using exclusive destination creation. */
async function copyEntry(source: string, target: string, expected: { bytes: number; sha256: string }, signal?: AbortSignal) {
  check(signal); const before = await ordinary(source, false);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("源文件在打开时变化");
    const output = await open(target, "wx", 0o600);
    try {
      const hash = createHash("sha256"); let count = 0;
      for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
        check(signal); count += chunk.length;
        if (count > expected.bytes) throw new Error("源文件大小变化");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) { const result = await output.write(chunk, offset); if (!result.bytesWritten) throw new Error("写入未完成"); offset += result.bytesWritten; }
      }
      if (count !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new Error("源文件内容变化");
      await output.sync();
      const after = await ordinary(source, false);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("源文件在复制期间变化");
    } finally { await output.close(); }
  } finally { await input.close(); }
}

/** Standalone local service. Never opens a working database, migrates, or changes app configuration.
 * Requires a trusted local parent directory. Identity checks detect replacement but absolute-path
 * Node APIs are not an OS sandbox against a hostile same-user process continuously racing writes.
 */
export class IsolatedRestore {
  private running = false;
  constructor(private readonly options: { currentWorkspace: string; decode: ReferenceDecoder }) {}
  async restore(sourceDirectory: string, destinationParent: string, signal?: AbortSignal, expectedManifestSha256?: string): Promise<IsolatedRestoreResult> {
    if (this.running) throw new ApplicationError("CONFLICT", "隔离恢复正在进行，请等待当前操作完成。");
    this.running = true;
    let output: string | undefined, identity: Awaited<ReturnType<typeof lstat>> | undefined;
    const owned = new Map<string, Awaited<ReturnType<typeof lstat>>>();
    try {
      check(signal);
      const source = resolve(sourceDirectory), parent = resolve(destinationParent), current = resolve(this.options.currentWorkspace);
      const sourceIdentity = await ordinary(source, true); const parentIdentity = await ordinary(parent, true); await ordinary(current, true);
      if (within(source, parent) || within(current, parent)) throw new Error("输出父目录不可位于原备份或当前工作区内");
      const initial = await manifestBytes(source);
      if (expectedManifestSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(expectedManifestSha256)
        || createHash("sha256").update(initial).digest("hex") !== expectedManifestSha256))
        throw new ApplicationError("CONFLICT", "备份与已确认预览不同，请重新选择并确认。");
      // Parse the captured bytes themselves: a validator reading a different ABA snapshot
      // must never authorize paths taken from these bytes.
      const manifest = backupManifestSchema.parse(JSON.parse(initial.toString("utf8")));
      const paths = manifest.files.map(file => file.path.toLowerCase());
      if (new Set(paths).size !== paths.length || paths.filter(path => path === "workspace.sqlite").length !== 1) throw new Error("清单重复或缺少数据库");
      await validateBackupDirectory(source, this.options.decode); check(signal);
      if (!initial.equals(await manifestBytes(source))) throw new Error("验证期间清单变化");
      const now = await ordinary(parent, true);
      if (now.dev !== parentIdentity.dev || now.ino !== parentIdentity.ino) throw new Error("输出目录变化");
      output = await mkdtemp(join(parent, ".DouBaoVideo-isolated-"));
      identity = await ordinary(output, true);
      owned.set(parent, parentIdentity); owned.set(output, identity);
      async function assertOwned() {
        for (const [path, expected] of owned) {
          const actual = await ordinary(path, true);
          if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("输出路径身份变化");
        }
      }
      await assertOwned(); await mkdir(join(output, "media"), { mode: 0o700 });
      owned.set(join(output, "media"), await ordinary(join(output, "media"), true));
      await assertOwned(); await mkdir(join(output, "media", "references"), { mode: 0o700 });
      owned.set(join(output, "media", "references"), await ordinary(join(output, "media", "references"), true));
      for (const file of manifest.files) {
        await ordinary(source, true); await ordinary(join(source, "media"), true); await ordinary(join(source, "media", "references"), true);
        await assertOwned();
        const target = resolve(output, file.path);
        if (isAbsolute(file.path) || !within(output, target) || target === output) throw new Error("复制路径越界");
        await copyEntry(join(source, file.path), join(output, file.path), file, signal);
      }
      check(signal);
      // Manifest is written last. Any subsequent failure removes it before cleanup.
      await assertOwned();
      const handle = await open(join(output, "manifest.json"), "wx", 0o600);
      try { await handle.writeFile(initial); await handle.sync(); } finally { await handle.close(); }
      await validateBackupDirectory(output, this.options.decode);
      await validateBackupDirectory(source, this.options.decode); check(signal);
      if (!initial.equals(await manifestBytes(source)) || !initial.equals(await manifestBytes(output))) throw new Error("恢复期间清单变化");
      const finalSource = await ordinary(source, true);
      if (finalSource.dev !== sourceIdentity.dev || finalSource.ino !== sourceIdentity.ino) throw new Error("源备份目录变化");
      await assertOwned();
      const result = await validateBackupDirectory(output, this.options.decode); check(signal);
      await assertOwned();
      const finalIdentity = await ordinary(output, true);
      if (finalIdentity.dev !== identity.dev || finalIdentity.ino !== identity.ino) throw new Error("隔离输出目录变化");
      return { ...result, isolated: true as const, workspaceActivated: false as const, videoFilesIncluded: false as const,
        notice: "仅创建独立业务数据库与静态图副本，未切换工作区；不含视频或应用会话凭据。业务文本中自行写入的秘密仍会复制。文件完整性不等于来源真实性或全部业务可用性。" };
    } catch (cause) {
      if (output && identity) {
        try {
          const actual = await ordinary(output, true);
          if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error("输出身份变化，拒绝清理");
          for (const [path, expected] of owned) {
            const entry = await ordinary(path, true);
            if (entry.dev !== expected.dev || entry.ino !== expected.ino) throw new Error("子目录身份变化，拒绝清理");
          }
          await unlink(join(output, "manifest.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
          await rm(output, { recursive: true, force: false });
        } catch {
          throw new ApplicationError("STORAGE_ERROR", `隔离恢复未完成，临时输出无法安全清理：${output}。请勿将其作为成功副本；原备份和当前工作区未由本服务修改。`);
        }
      }
      if (output && !identity) throw new ApplicationError("STORAGE_ERROR", `隔离恢复未完成，无法确认新目录身份，请勿使用：${output}。未切换当前工作区。`);
      throw new ApplicationError("INVALID_INPUT", `隔离恢复未完成：${cause instanceof Error ? cause.message : "读取或写入失败"}。未切换或覆盖当前工作区。`);
    } finally { this.running = false; }
  }
}
