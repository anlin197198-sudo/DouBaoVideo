import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import {
  isPrivateVideoProbeJs, PRIVATE_VIDEO_PROBE_ASSET_MANIFEST, PRIVATE_VIDEO_PROBE_HTML_FILE,
  PRIVATE_VIDEO_PROBE_MAX_BYTES, PRIVATE_VIDEO_PROBE_MAX_JS_FILES,
  privateVideoProbeResourceLimit, type PrivateVideoProbeResource,
} from "../src/shared/private-video-probe-resource-contract";

type BuildOutput =
  | { type: "asset"; source: string | Uint8Array }
  | { type: "chunk"; name: string; isEntry: boolean; fileName: string; code: string; imports: readonly string[]; dynamicImports: readonly string[] };

const invalid = () => new Error("Private video probe build resources are incomplete or unexpected.");
const record = (file: string, bytes: Uint8Array): PrivateVideoProbeResource => {
  if (!bytes.length || bytes.length > privateVideoProbeResourceLimit(file)) throw invalid();
  return { file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};

export function collectPrivateVideoProbeResources(bundle: Readonly<Record<string, BuildOutput>>) {
  const entries = Object.values(bundle).filter(chunk =>
    chunk.type === "chunk" && chunk.isEntry && chunk.name === "f17-video-probe",
  );
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.type !== "chunk") throw invalid();

  const html = bundle[PRIVATE_VIDEO_PROBE_HTML_FILE];
  if (html?.type !== "asset") throw invalid();
  const htmlSource = Buffer.from(html.source).toString("utf8");
  const scriptTags = [...htmlSource.matchAll(/<script\b[^>]*>/gi)];
  const scriptSrc = scriptTags[0]?.[0].match(/\bsrc="(?:\.\/|\/)?([^"]+)"/)?.[1];
  if (scriptTags.length !== 1 || scriptSrc !== entry.fileName) throw invalid();

  const files = new Map<string, PrivateVideoProbeResource>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    const chunk = bundle[file];
    if (!isPrivateVideoProbeJs(file) || chunk?.type !== "chunk" ||
      (file !== entry.fileName && chunk.isEntry) || chunk.dynamicImports.length ||
      files.size >= PRIVATE_VIDEO_PROBE_MAX_JS_FILES) throw invalid();
    files.set(file, record(file, Buffer.from(chunk.code)));
    for (const dependency of chunk.imports) visit(dependency);
  };
  visit(entry.fileName);

  for (const [tag] of htmlSource.matchAll(/<link\b[^>]*>/gi)) {
    if (/\brel="modulepreload"/i.test(tag)) {
      const href = tag.match(/\bhref="(?:\.\/|\/)?([^"]+)"/)?.[1];
      if (!href || !files.has(href)) throw invalid();
    }
  }
  const resources = [record(PRIVATE_VIDEO_PROBE_HTML_FILE, Buffer.from(html.source)),
    ...[...files.values()].sort((a, b) => a.file.localeCompare(b.file))];
  if (resources.reduce((total, { size }) => total + size, 0) > PRIVATE_VIDEO_PROBE_MAX_BYTES) throw invalid();
  return { version: 1, entry: entry.fileName, resources };
}

export function privateVideoProbeManifest(): Plugin {
  return {
    name: "private-video-probe-resource-manifest",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        this.emitFile({ type: "asset", fileName: PRIVATE_VIDEO_PROBE_ASSET_MANIFEST,
          source: JSON.stringify(collectPrivateVideoProbeResources(bundle)) });
      },
    },
  };
}
