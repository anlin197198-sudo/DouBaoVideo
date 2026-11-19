import { z } from "zod";
export const MAX_VIDEO_BASENAME_UNITS = 240;
export const MAX_VIDEO_TITLE_UNITS = 2000;
const schema = z.object({ taskId: z.string().uuid(), executionId: z.string().uuid(),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), title: z.string().max(MAX_VIDEO_TITLE_UNITS) }).strict();
export type VideoBasenameInput = z.infer<typeof schema>;
const reserved = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;
function safeTitle(raw: string): string {
  // Iterate code points to replace unpaired UTF-16 surrogates, not split valid emoji pairs.
  const wellFormed = [...raw].map(c => c.length === 1 && /[\uD800-\uDFFF]/.test(c) ? "_" : c).join("");
  const clean = wellFormed.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g, "_").trim().replace(/[. ]+$/g, "");
  if (!clean || /^[._]+$/.test(clean)) return "video";
  return reserved.test(clean) ? `_${clean}` : clean;
}
/** A deterministic basename candidate only: no path, I/O, download or media validity claim.
 * Full identity suffixes distinguish task/execution/version even on case-insensitive Windows.
 * Same normalized inputs produce the same name. The future writer MUST exclusive-create:
 * this pure function does not reserve a filename or protect an existing file from overwrite.
 * The 240 UTF-16 unit budget is for the basename, not the whole destination path. */
export function buildVideoBasename(raw: unknown): string {
  let input: VideoBasenameInput;
  try { input = schema.parse(raw); } catch { throw new Error("视频候选文件名输入无效。"); }
  const suffix = `--${input.taskId.toLowerCase()}--${input.executionId.toLowerCase()}--v${input.version}.mp4`;
  const budget = MAX_VIDEO_BASENAME_UNITS - suffix.length;
  let title = "";
  for (const codePoint of safeTitle(input.title)) { if (title.length + codePoint.length > budget) break; title += codePoint; }
  title = title.replace(/[. ]+$/g, "") || "video";
  return title + suffix;
}
