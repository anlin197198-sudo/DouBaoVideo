export const PRIVATE_VIDEO_PROBE_HOST = "app://video-probe";
export const PRIVATE_VIDEO_PROBE_HTML_FILE = "f17-video-probe.html";
export const PRIVATE_VIDEO_PROBE_ASSET_MANIFEST = "f17-video-probe-assets.json";
export const PRIVATE_VIDEO_PROBE_CSP = "default-src 'none'; script-src 'self'; media-src app://video; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'none'";
export const PRIVATE_VIDEO_PROBE_MAX_JS_FILES = 16;
export const PRIVATE_VIDEO_PROBE_MAX_BYTES = 4 * 1024 * 1024;
export const PRIVATE_VIDEO_PROBE_MANIFEST_MAX_BYTES = 64 * 1024;
export type PrivateVideoProbeResource = { file: string; size: number; sha256: string };

const hashedJs = /^assets\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}-[A-Za-z0-9_-]{8,32}\.js$/;
export function isPrivateVideoProbeJs(file: string): boolean {
  return hashedJs.test(file) && !/\s/.test(file) && !/^assets\/(?:index|main|preload)-/i.test(file);
}
export function privateVideoProbeResourceLimit(file: string): number {
  return file === PRIVATE_VIDEO_PROBE_HTML_FILE ? 32 * 1024 : 1024 * 1024;
}
