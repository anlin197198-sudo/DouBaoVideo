import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectPrivateVideoProbeResources } from "../packaging/private-video-probe-manifest";
import { createPrivateVideoProbePageLoader } from "../src/main/electron/private-video-probe-page-loader";
import {
  PRIVATE_VIDEO_PROBE_ASSET_MANIFEST, PRIVATE_VIDEO_PROBE_CSP, PRIVATE_VIDEO_PROBE_HOST,
  PRIVATE_VIDEO_PROBE_HTML_FILE, PRIVATE_VIDEO_PROBE_MANIFEST_MAX_BYTES,
} from "../src/shared/private-video-probe-resource-contract";

const html = "<!doctype html><script type=\"module\" src=\"./assets/f17-video-probe-Aa0_-BC1.js\"></script>";
const script = "import './probe-chunk-Aa0_-BC1.js';";
const chunk = "export const proof = 1;";
const names = [PRIVATE_VIDEO_PROBE_HTML_FILE, "assets/f17-video-probe-Aa0_-BC1.js", "assets/probe-chunk-Aa0_-BC1.js"] as const;
const url = (name: string) => `${PRIVATE_VIDEO_PROBE_HOST}/${name}`;

function fixture(t: { after: (fn: () => void) => unknown }) {
  const root = mkdtempSync(join(tmpdir(), "dv-f17-private-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets"));
  const resources = names.map((file, i) => {
    const bytes = Buffer.from([html, script, chunk][i]!);
    writeFileSync(join(root, file), bytes);
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  });
  const manifest = { version: 1, entry: names[1], resources };
  const writeManifest = (data: unknown) => writeFileSync(join(root, PRIVATE_VIDEO_PROBE_ASSET_MANIFEST), JSON.stringify(data));
  writeManifest(manifest);
  return { root, manifest, writeManifest };
}

const blockedBuild = (error: unknown) =>
  error instanceof Error && error.message === "无法准备专用视频探测资源。" && error.cause === undefined;

test("F17 fixed loader serves exactly pinned HTML and static JS from memory with private headers", async t => {
  const { root } = fixture(t), serve = createPrivateVideoProbePageLoader(root);
  // Loading happens before the host opens a window; later disk bytes are not reread.
  writeFileSync(join(root, names[1]), "replacement");
  for (const [name, type, expected] of [
    [names[0], "text/html; charset=utf-8", html],
    [names[1], "text/javascript; charset=utf-8", script],
    [names[2], "text/javascript; charset=utf-8", chunk],
  ] as const) {
    const response = serve({ method: "GET", url: url(name) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), type);
    assert.equal(response.headers.get("Content-Length"), String(Buffer.byteLength(expected)));
    assert.equal(response.headers.get("Content-Security-Policy"), PRIVATE_VIDEO_PROBE_CSP);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(await response.text(), expected);
    const head = serve({ method: "HEAD", url: url(name) });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Length"), String(Buffer.byteLength(expected)));
    assert.equal(head.body, null);
  }
});

test("F17 loader declines unlisted files, normal renderer, preload, manifest, alternate origins and decorated URLs", async t => {
  const { root } = fixture(t), serve = createPrivateVideoProbePageLoader(root);
  writeFileSync(join(root, "index.html"), "normal");
  writeFileSync(join(root, "assets/not-in-entry-Aa0_-BC1.js"), "other");
  for (const candidate of [
    url("index.html"), url(PRIVATE_VIDEO_PROBE_ASSET_MANIFEST), url("assets/not-in-entry-Aa0_-BC1.js"),
    url("../preload/index.cjs"), url("assets/%2e%2e/index.html"), url("./" + names[0]), url(names[0] + "/"),
    url(names[0] + "?x=1"), url(names[0] + "#550e8400-e29b-41d4-a716-446655440000"), url(names[0] + "\n"),
    "app://renderer/" + names[0], "app://video/" + names[0], "file:///tmp/" + names[0],
    "https://video-probe/" + names[0], "app://user@video-probe/" + names[0], "app://video-probe:80/" + names[0],
  ]) {
    const result = serve({ method: "GET", url: candidate });
    assert.equal(result.status, 404, candidate);
    assert.equal(result.body, null);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(serve({ method: "POST", url: url(names[0]) }).status, 404);
});

test("F17 loader rejects unknown path shapes, duplicates, altered headers and oversized manifests without detail", t => {
  const { root, manifest, writeManifest } = fixture(t);
  for (const file of ["index.html", "../private.mp4", "assets/trailing-AbCd1234.js\n", "/tmp/root.js",
    "assets/../index-AbCd1234.js", "assets/index-AbCd1234.js", "assets/preload-AbCd1234.js", "assets/x-Aa0_-BC1.js.map",
  ]) {
    writeManifest({ ...manifest, resources: [...manifest.resources.slice(0, 2), { ...manifest.resources[2], file }] });
    assert.throws(() => createPrivateVideoProbePageLoader(root), blockedBuild);
  }
  for (const bad of [
    { ...manifest, unexpected: "secret" },
    { ...manifest, version: 2 },
    { ...manifest, entry: names[2] },
    { ...manifest, resources: manifest.resources.slice(1) },
    { ...manifest, resources: [...manifest.resources, manifest.resources[1]] },
    { ...manifest, resources: [manifest.resources[0], { ...manifest.resources[1], sha256: "0".repeat(64) }] },
    { ...manifest, resources: [manifest.resources[0], { ...manifest.resources[1], size: 20 * 1024 * 1024 }] },
  ]) {
    writeManifest(bad);
    assert.throws(() => createPrivateVideoProbePageLoader(root), blockedBuild);
  }
  writeFileSync(join(root, PRIVATE_VIDEO_PROBE_ASSET_MANIFEST), Buffer.alloc(PRIVATE_VIDEO_PROBE_MANIFEST_MAX_BYTES + 1));
  assert.throws(() => createPrivateVideoProbePageLoader(root), blockedBuild);
});

test("F17 loader fails closed on changed same-length asset or symlink, including a linked ancestor", t => {
  const { root } = fixture(t);
  const target = join(root, names[1]), original = readFileSync(target);
  const altered = Buffer.from(original); altered[0] = 0x30;
  writeFileSync(target, altered);
  assert.throws(() => createPrivateVideoProbePageLoader(root), blockedBuild);
  writeFileSync(target, original);
  const external = mkdtempSync(join(tmpdir(), "dv-f17-private-external-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const outside = join(external, "identical.js");
  writeFileSync(outside, original);
  rmSync(target);
  try {
    symlinkSync(outside, target, "file");
    assert.throws(() => createPrivateVideoProbePageLoader(root), blockedBuild);
    rmSync(target);
  } catch (error) {
    if (process.platform !== "win32" || !(error instanceof Error) ||
      !("code" in error) || (error.code !== "EPERM" && error.code !== "ENOTSUP")) throw error;
    // A Windows machine without symlink permission still exercises the junction below.
  }
  writeFileSync(target, original);
  renameSync(join(root, "assets"), join(external, "assets"));
  symlinkSync(join(external, "assets"), join(root, "assets"), "junction");
  assert.throws(() => createPrivateVideoProbePageLoader(root), blockedBuild);
});

const regularEntry = "assets/index-bbbb2222.js";
const disconnected = "assets/disconnected-cccc3333.js";
function vited() {
  const chunk = (fileName: string, name: string, isEntry: boolean, imports: string[] = [], dynamicImports: string[] = []) =>
    ({ type: "chunk" as const, fileName, name, isEntry, imports, dynamicImports, code: "export const proof = 1;" });
  return {
    [names[0]]: { type: "asset" as const, source: html + `<link rel="modulepreload" href="./${names[2]}">` },
    [names[1]]: chunk(names[1], "f17-video-probe", true, [names[2]]),
    [names[2]]: chunk(names[2], "probe-chunk", false),
    [regularEntry]: chunk(regularEntry, "index", true),
    [disconnected]: chunk(disconnected, "disconnected", false),
  };
}

test("F17 build manifests only the static private entry graph, pinning content without normal renderer assets", () => {
  const bundle = vited();
  const manifest = collectPrivateVideoProbeResources(bundle);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entry, names[1]);
  assert.deepEqual(manifest.resources.map(resource => resource.file), [...names]);
  for (const resource of manifest.resources) {
    const artifact = bundle[resource.file as keyof typeof bundle];
    assert(artifact);
    const bytes = Buffer.from(artifact.type === "asset" ? artifact.source : artifact.code);
    assert.equal(resource.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(resource.size, bytes.length);
  }
});

test("F17 build fails on cross-entry imports, unknown preloads, dynamic or external dependencies", () => {
  const input = vited();
  for (const bundle of [
    { ...input, [names[1]]: { ...input[names[1]], imports: [regularEntry] } },
    { ...input, [names[1]]: { ...input[names[1]], imports: ["https://example.invalid/file.js"] } },
    { ...input, [names[1]]: { ...input[names[1]], dynamicImports: [names[2]] } },
    { ...input, [names[0]]: { ...input[names[0]], source: html + `<link rel="modulepreload" href="./${disconnected}">` } },
    { ...input, [names[0]]: { ...input[names[0]], source: html + `<script src="./${regularEntry}"></script>` } },
    { ...input, [names[2]]: { ...input[names[2]], isEntry: true } },
  ]) assert.throws(() => collectPrivateVideoProbeResources(bundle), /Private video probe build resources/);
});
