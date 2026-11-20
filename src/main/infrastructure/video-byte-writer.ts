import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, open, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildVideoBasename, type VideoBasenameInput } from "../../shared/video-basename";

/** Local resource limit, not a provider/media capability limit. */
export const MAX_VIDEO_WRITE_BYTES = 8 * 1024 ** 3;
type Identity = { dev: number; ino: number };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
export interface VideoByteWriteInput {
  directory: string; identity: VideoBasenameInput; expectedBytes: number; expectedSha256: string;
  chunks: AsyncIterable<Uint8Array>;
  /** Trusted synchronous gate only. Cannot cancel a link operation already begun. */
  beforePublish?: () => boolean;
}
export interface VideoByteWriteResult {
  /** Original owned publication identity, not a fresh pathname observation. Absent unless clean publication. */
  publishedIdentity?: Readonly<{dev:number;ino:number;parentDev:number;parentIno:number;size:number;mtimeMs:number;ctimeMs:number}>;
  status: "published" | "published-cleanup-failed" | "not-published" | "publication-uncertain";
  reason: "VERIFIED_BYTES_PUBLISHED" | "WRITE_OR_VERIFY_FAILED" | "EXCLUSIVE_PUBLICATION_FAILED" | "PUBLICATION_NOT_CONFIRMED" | "TEMPORARY_CLEANUP_FAILED" | "PUBLICATION_GUARD_REJECTED";
  target: string; temporary: string | null; cleanup: "removed" | "not-created" | "retained" | "unknown";
  automaticRetry: false; mediaValidated: false; databaseCompleted: false;
}
/** Trusted local parent only, not a sandbox against hostile same-user path replacement.
 * Input media validity is the caller's responsibility; this primitive checks only exact bytes/hash.
 * File fsync is used; no claim of directory-entry durability across power loss.
 * Injected I/O must preserve real filesystem semantics (used for deterministic failure tests).
 * Never deletes or overwrites the published target, even after cleanup/publication response failure. */
export async function writeVerifiedVideoBytes(input: VideoByteWriteInput,
  io: { link?: typeof link; unlink?: typeof unlink } = {}): Promise<VideoByteWriteResult> {
  const name = buildVideoBasename(input.identity);
  if (typeof input.directory !== "string" || !input.directory || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0 || input.expectedBytes > MAX_VIDEO_WRITE_BYTES
    || typeof input.expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedSha256)) throw new Error("视频字节写入参数无效。");
  // Capture metadata before the first await; stream content is verified against this exact contract.
  const parent = resolve(input.directory), target = join(parent, name), expectedBytes = input.expectedBytes, expectedHash = input.expectedSha256, chunks = input.chunks, beforePublish = input.beforePublish;
  let temporary: string | null = null, owned: Identity | null = null, parentIdentity: Identity | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null, publishAttempted = false, linkResolved = false, created = false, published = false, uncertain = false;
  let reason: VideoByteWriteResult["reason"] = "WRITE_OR_VERIFY_FAILED";
  const parentCurrent = async () => {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(parent)) !== parent || (parentIdentity && !same(stat, parentIdentity))) throw new Error("PARENT_CHANGED");
    return stat;
  };
  const tempCurrent = async () => {
    await parentCurrent();
    const stat = await lstat(temporary!);
    if (!owned || !stat.isFile() || stat.isSymbolicLink() || !same(stat, owned)) throw new Error("TEMP_CHANGED");
  };
  const checkPublicationGuard = () => {
    if (beforePublish === undefined) return;
    try {
      if (typeof beforePublish !== "function") throw new Error();
      const answer: unknown = beforePublish();
      // Wrong runtime async input is rejected, but do not leave its rejection unobserved.
      if (answer instanceof Promise) void answer.catch(() => undefined);
      if (answer !== true) throw new Error();
    }
    catch { reason = "PUBLICATION_GUARD_REJECTED"; throw new Error("PUBLICATION_GUARD_REJECTED"); }
  };
  try {
    checkPublicationGuard();
    parentIdentity = await parentCurrent();
    temporary = join(parent, `.doubao-video-${randomUUID()}.tmp`);
    handle = await open(temporary, "wx", 0o600); created = true; owned = await handle.stat();
    const hash = createHash("sha256"); let written = 0;
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > expectedBytes - written) throw new Error("LENGTH_OR_CHUNK");
      for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
        const bytes = Buffer.from(chunk.subarray(offset, Math.min(chunk.byteLength, offset + 65536)));
        let cursor = 0;
        while (cursor < bytes.length) { const result = await handle.write(bytes, cursor, bytes.length - cursor); if (result.bytesWritten <= 0) throw new Error("SHORT_WRITE"); cursor += result.bytesWritten; }
        hash.update(bytes); written += bytes.length;
      }
    }
    if (written !== expectedBytes || hash.digest("hex") !== expectedHash || (await handle.stat()).size !== expectedBytes) throw new Error("BYTE_MISMATCH");
    await handle.sync(); await handle.close(); handle = null;
    await tempCurrent();
    checkPublicationGuard();
    publishAttempted = true; reason = "EXCLUSIVE_PUBLICATION_FAILED";
    await (io.link ?? link)(temporary, target); linkResolved = true;
    const final = await lstat(target);
    if (!final.isFile() || !same(final, owned)) throw new Error("PUBLICATION_IDENTITY");
    published = true; reason = "VERIFIED_BYTES_PUBLISHED";
  } catch (cause) {
    if (publishAttempted) {
      // Link may have succeeded before a response/error was observed: never blindly retry.
      try { await parentCurrent(); const final = await lstat(target); published = !!owned && final.isFile() && !final.isSymbolicLink() && same(final, owned); if (linkResolved && !published) uncertain = true; }
      catch (error) { if (linkResolved || (error as NodeJS.ErrnoException).code !== "ENOENT") uncertain = true; }
      if (!published && !["EEXIST", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes((cause as NodeJS.ErrnoException)?.code ?? "")) uncertain = true;
      if (published) reason = "VERIFIED_BYTES_PUBLISHED";
      else if (uncertain) reason = "PUBLICATION_NOT_CONFIRMED";
    }
  }
  let cleanup: VideoByteWriteResult["cleanup"] = created ? "retained" : "not-created";
  try {
    if (handle) { await handle.close(); handle = null; }
    if (temporary && owned) { await tempCurrent(); await (io.unlink ?? unlink)(temporary); cleanup = "removed"; }
  } catch {
    cleanup = "unknown";
    if (temporary && created) {
      try {
        await parentCurrent();
        try { const remaining = await lstat(temporary); if (owned && remaining.isFile() && !remaining.isSymbolicLink() && same(remaining, owned)) cleanup = "retained"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !handle) cleanup = "removed"; }
      } catch { /* Parent identity cannot be verified: do not claim its temporary was removed. */ }
    }
  }
  const status = published ? (cleanup === "retained" || cleanup === "unknown") ? "published-cleanup-failed" : "published" : uncertain ? "publication-uncertain" : "not-published";
  if ((cleanup === "retained" || cleanup === "unknown") && !uncertain) reason = "TEMPORARY_CLEANUP_FAILED";
  let publishedIdentity: VideoByteWriteResult["publishedIdentity"];
  if (status === "published" && cleanup === "removed" && owned && parentIdentity && owned.ino > 0 && parentIdentity.ino > 0
    && [owned.dev,owned.ino,parentIdentity.dev,parentIdentity.ino].every(value=>Number.isSafeInteger(value)&&value>=0)) {
    try {
      await parentCurrent();
      const baseline = await lstat(target);
      if (baseline.isFile() && !baseline.isSymbolicLink() && baseline.nlink === 1 && same(baseline,owned)
        && baseline.size === expectedBytes && [baseline.mtimeMs,baseline.ctimeMs].every(value=>Number.isFinite(value)&&value>=0)) {
        publishedIdentity = Object.freeze({dev:owned.dev,ino:owned.ino,parentDev:parentIdentity.dev,parentIno:parentIdentity.ino,
          size:baseline.size,mtimeMs:baseline.mtimeMs,ctimeMs:baseline.ctimeMs});
      }
    } catch { /* Published remains truthful; unavailable post-cleanup baseline grants no proof. */ }
  }
  return Object.freeze({ ...(publishedIdentity ? {publishedIdentity} : {}), status, reason, target, temporary: cleanup === "retained" || cleanup === "unknown" ? temporary : null, cleanup,
    automaticRetry: false, mediaValidated: false, databaseCompleted: false });
}
