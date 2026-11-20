import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isPrivateVideoProbeJs, PRIVATE_VIDEO_PROBE_ASSET_MANIFEST, PRIVATE_VIDEO_PROBE_CSP,
  PRIVATE_VIDEO_PROBE_HOST, PRIVATE_VIDEO_PROBE_HTML_FILE, PRIVATE_VIDEO_PROBE_MANIFEST_MAX_BYTES,
  PRIVATE_VIDEO_PROBE_MAX_BYTES, PRIVATE_VIDEO_PROBE_MAX_JS_FILES,
  privateVideoProbeResourceLimit, type PrivateVideoProbeResource,
} from "../../shared/private-video-probe-resource-contract";

const invalid = () => new Error("无法准备专用视频探测资源。");
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const entryFile = /^assets\/f17-video-probe-[A-Za-z0-9_-]{8,32}\.js$/;

function parseManifest(bytes: Uint8Array): PrivateVideoProbeResource[] {
  const raw = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!raw || !exactKeys(raw, ["version", "entry", "resources"]) || raw.version !== 1 ||
    typeof raw.entry !== "string" || !entryFile.test(raw.entry) || !isPrivateVideoProbeJs(raw.entry) ||
    !Array.isArray(raw.resources) || raw.resources.length < 2 ||
    raw.resources.length > PRIVATE_VIDEO_PROBE_MAX_JS_FILES + 1) throw invalid();

  const files = new Set<string>();
  let total = 0;
  const resources: PrivateVideoProbeResource[] = [];
  for (const value of raw.resources) {
    const row = object(value);
    if (!row || !exactKeys(row, ["file", "size", "sha256"]) || typeof row.file !== "string" ||
      (row.file !== PRIVATE_VIDEO_PROBE_HTML_FILE && !isPrivateVideoProbeJs(row.file)) ||
      typeof row.sha256 !== "string" || row.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(row.sha256) ||
      typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 1 ||
      row.size > privateVideoProbeResourceLimit(row.file) || files.has(row.file)) throw invalid();
    total += row.size;
    if (total > PRIVATE_VIDEO_PROBE_MAX_BYTES) throw invalid();
    files.add(row.file);
    resources.push({ file: row.file, size: row.size, sha256: row.sha256 });
  }
  if (!files.has(PRIVATE_VIDEO_PROBE_HTML_FILE) || !files.has(raw.entry)) throw invalid();
  return resources;
}

/** Fixed allowlisted packaged names only; read at most the stat size via a single file descriptor. */
function readFixed(root: string, name: string, limit: number, expectedSize?: number): Uint8Array<ArrayBuffer> {
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) ||
    realpathSync(path) !== path || !lstatSync(path).isFile()) throw invalid();
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > limit ||
      (expectedSize !== undefined && expectedSize !== stat.size)) throw invalid();
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw invalid();
      offset += count;
    }
    if (fstatSync(fd).size !== stat.size) throw invalid();
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export type PrivateVideoProbePageRequest = Pick<Request, "url" | "method">;
export type PrivateVideoProbePageLoader = (request: PrivateVideoProbePageRequest) => Response;

function headers(type?: string, length?: number): Headers {
  const result = new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": PRIVATE_VIDEO_PROBE_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (type) result.set("Content-Type", type);
  if (length !== undefined) result.set("Content-Length", String(length));
  return result;
}

/** Unbound main-process route loader. rendererDirectory must be the host's trusted packaged renderer directory. */
export function createPrivateVideoProbePageLoader(rendererDirectory: string): PrivateVideoProbePageLoader {
  const entries = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>();
  try {
    const root = realpathSync(rendererDirectory);
    if (!lstatSync(root).isDirectory()) throw invalid();
    const manifest = parseManifest(readFixed(root, PRIVATE_VIDEO_PROBE_ASSET_MANIFEST, PRIVATE_VIDEO_PROBE_MANIFEST_MAX_BYTES));
    for (const { file, size, sha256 } of manifest) {
      const bytes = readFixed(root, file, privateVideoProbeResourceLimit(file), size);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw invalid();
      entries.set(`${PRIVATE_VIDEO_PROBE_HOST}/${file}`, {
        bytes, type: file === PRIVATE_VIDEO_PROBE_HTML_FILE ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      });
    }
  } catch { throw invalid(); }

  return request => {
    // The normal Electron request excludes fragments. The page receives the token via navigation only.
    const asset = request.method === "GET" || request.method === "HEAD" ? entries.get(request.url) : undefined;
    if (!asset) return new Response(null, { status: 404, headers: headers() });
    return new Response(request.method === "HEAD" ? null : asset.bytes.slice(), {
      status: 200,
      headers: headers(asset.type, asset.bytes.byteLength),
    });
  };
}
