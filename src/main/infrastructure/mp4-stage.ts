import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { MAX_VIDEO_WRITE_BYTES } from "./video-byte-writer";
import type { VideoProbeAcquire } from "../application/video-probe-registry";
import type { intakeMp4, Mp4Selection } from "./mp4-intake";

type Intake = Pick<Awaited<ReturnType<typeof intakeMp4>>, "evidence" | "stream">;
type Cleanup = "removed" | "retained-or-unknown";
type StageResult = Readonly<
  { status: "staged"; snapshot: Readonly<{ path: string; identity: Mp4Selection;
    fingerprint: Readonly<{ bytes: number; sha256: string }>; acquire: VideoProbeAcquire }>; discard: () => Promise<Cleanup> }
  | { status: "cancelled" | "failed"; cleanup: Cleanup | "not-created" }
>;
const sameFile = (left: Pick<Mp4Selection, "dev" | "ino">, right: Pick<Mp4Selection, "dev" | "ino">) =>
  left.dev === right.dev && left.ino === right.ino;
const pin = ({ dev, ino, size, mtimeMs, ctimeMs }: Stats): Mp4Selection => Object.freeze({ dev, ino, size, mtimeMs, ctimeMs });
const unchanged = (a: Mp4Selection, b: Mp4Selection) =>
  sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const rejection = () => new Error("本地 MP4 暂存目录或文件不可用。");

/** An explicit, dedicated trusted local root is required. Not a hostile same-user filesystem sandbox.
 * The result is a main-only byte snapshot, NOT decoder evidence or a publication. Never scan or clean other entries. */
export async function createMp4Stage(parent: string) {
  if (typeof parent !== "string" || !isAbsolute(parent) || resolve(parent) !== parent || parse(parent).root === parent) throw rejection();
  async function directory() {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent) throw rejection();
    return stat;
  }
  const root = await directory().catch(() => { throw rejection(); });
  async function checkRoot() { if (!sameFile(root, await directory())) throw rejection(); }
  return async (source: Intake, signal?: AbortSignal): Promise<StageResult> => {
    let path: string | undefined, owned: Mp4Selection | undefined, verified: Mp4Selection | undefined;
    let handle: FileHandle | undefined, created = false;
    const checkAbort = () => { if (signal?.aborted) throw rejection(); };
    const checkFile = async () => {
      await checkRoot();
      if (!path || !owned) throw rejection();
      const now = await lstat(path);
      if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1 || !sameFile(now, owned)
        || (verified && !unchanged(now, verified)) || await realpath(path) !== path) throw rejection();
      return now;
    };
    const discard = async (): Promise<Cleanup> => {
      try { await checkFile(); await unlink(path!); return "removed"; }
      catch { return "retained-or-unknown"; }
    };
    try {
      checkAbort();
      const { bytes, sha256, structureChecked, decoded } = source.evidence;
      if (structureChecked !== true || decoded !== false || !Number.isSafeInteger(bytes)
        || bytes < 1 || bytes > MAX_VIDEO_WRITE_BYTES || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw rejection();
      await checkRoot();
      checkAbort();
      path = join(parent, `.doubao-mp4-stage-${randomUUID()}.mp4`);
      handle = await open(path, "wx+", 0o600);
      created = true;
      const initial = await handle.stat();
      if (!initial.isFile() || initial.nlink !== 1) throw rejection();
      owned = pin(initial);
      await checkFile();
      checkAbort();
      let written = 0;
      const inputHash = createHash("sha256");
      for await (const chunk of source.stream()) {
        checkAbort();
        if (!(chunk instanceof Uint8Array) || chunk.length < 1 || chunk.length > bytes - written) throw rejection();
        for (let i = 0; i < chunk.length; i += 65536) {
          const block = Buffer.from(chunk.subarray(i, i + 65536));
          let offset = 0;
          while (offset < block.length) {
            checkAbort();
            const { bytesWritten } = await handle.write(block, offset, block.length - offset, written + offset);
            if (bytesWritten < 1) throw rejection();
            offset += bytesWritten;
          }
          written += block.length;
          inputHash.update(block);
        }
      }
      checkAbort();
      if (written !== bytes || inputHash.digest("hex") !== sha256) throw rejection();
      await handle.sync();
      const initialVerify = await handle.stat();
      if (!sameFile(initialVerify, initial) || initialVerify.nlink !== 1 || initialVerify.size !== bytes) throw rejection();
      const stagedHash = createHash("sha256"), buffer = Buffer.alloc(65536);
      for (let offset = 0; offset < bytes;) {
        checkAbort();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (bytesRead < 1) throw rejection();
        stagedHash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (!unchanged(initialVerify, await handle.stat()) || stagedHash.digest("hex") !== sha256) throw rejection();
      verified = pin(initialVerify);
      await handle.close();
      handle = undefined;
      await checkFile();
      checkAbort();
      const fingerprint = Object.freeze({ bytes, sha256 }), expected = verified, stagedPath = path;
      let cleanup: Promise<Cleanup> | undefined, discarded = false, closeFailed = false;
      const pending = new Set<Promise<Awaited<ReturnType<VideoProbeAcquire>>>>();
      const owners = new Set<() => Promise<void>>();
      function ensureLive() { if (discarded) throw rejection(); }
      async function acquirePinned(): ReturnType<VideoProbeAcquire> {
        let opened: FileHandle | undefined;
        try {
          ensureLive();
          await checkFile();
          ensureLive();
          opened = await open(stagedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          const file = opened;
          async function checkHandle() {
            ensureLive();
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1 || !unchanged(stat, expected)) throw rejection();
            ensureLive();
          }
          await checkHandle();
          const hash = createHash("sha256"), block = Buffer.alloc(65536);
          for (let offset = 0; offset < bytes;) {
            ensureLive();
            const { bytesRead } = await file.read(block, 0, Math.min(block.length, bytes - offset), offset);
            if (!bytesRead) throw rejection();
            hash.update(block.subarray(0, bytesRead));
            offset += bytesRead;
          }
          if (hash.digest("hex") !== sha256) throw rejection();
          await checkFile();
          await checkHandle();
          ensureLive();

          let streaming = false, closing: Promise<void> | undefined;
          const close = (): Promise<void> => closing ??= file.close().catch(() => {
            closeFailed = true;
            throw rejection();
          }).finally(() => owners.delete(close));
          owners.add(close);
          opened = undefined;
          return { fingerprint, source: Object.freeze({
            get byteLength() { ensureLive(); return bytes; },
            close: () => streaming ? Promise.resolve() : close(),
            stream(start: number, end: number) {
              ensureLive();
              if (streaming || closing || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
                || start < 0 || end < start || end >= bytes) throw rejection();
              streaming = true;
              let position = start, cancelled = false;
              return new ReadableStream<Uint8Array<ArrayBuffer>>({
                async pull(out) {
                  try {
                    if (cancelled) return;
                    await checkHandle();
                    const chunk = new Uint8Array(Math.min(65536, end - position + 1));
                    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
                    if (cancelled) return;
                    if (!bytesRead) throw rejection();
                    await checkHandle();
                    if (cancelled) return;
                    position += bytesRead;
                    out.enqueue(chunk.subarray(0, bytesRead));
                    if (position > end) { await close(); if (!cancelled) out.close(); }
                  } catch {
                    await close().catch(() => undefined);
                    if (!cancelled) out.error(rejection());
                  }
                },
                async cancel() { cancelled = true; await close(); },
              }, { highWaterMark: 0 });
            },
          }) };
        } catch {
          await opened?.close().catch(() => { closeFailed = true; });
          throw rejection();
        }
      }
      const acquire: VideoProbeAcquire = () => {
        if (discarded || pending.size + owners.size >= 8) return Promise.reject(rejection());
        const operation = acquirePinned().finally(() => pending.delete(operation));
        pending.add(operation);
        return operation;
      };
      const discardSnapshot = () => {
        discarded = true;
        return cleanup ??= (async (): Promise<Cleanup> => {
          await Promise.allSettled(pending);
          const closed = await Promise.allSettled([...owners].map(close => close()));
          if (closeFailed || closed.some(it => it.status === "rejected")) return "retained-or-unknown";
          return discard();
        })();
      };
      return Object.freeze({ status: "staged", snapshot: Object.freeze({ path, identity: verified,
        fingerprint, acquire }), discard: discardSnapshot });
    } catch {
      let cleanup: Cleanup | "not-created" = created ? "retained-or-unknown" : "not-created";
      try { await handle?.close(); if (created) cleanup = await discard(); } catch { /* Leave uncertain output alone. */ }
      return Object.freeze({ status: signal?.aborted ? "cancelled" : "failed", cleanup });
    }
  };
}
