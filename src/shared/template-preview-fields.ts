import type { PromptKind, TaskWorkspace } from "./models";
import { getTemplateInputGaps } from "./template-input-gaps";

export interface PreviewGlobalFields { tone: string; lighting: string; colorAnchor: string }
export const MAX_PREVIEW_GLOBAL_CHARS = 2000;
const keys = ["tone", "lighting", "colorAnchor"] as const;
/** Temporary explicit author input only. No persistence, inference, draft adoption or prompt edit. */
export function emptyPreviewGlobalFields(): Readonly<PreviewGlobalFields> {
  return Object.freeze({ tone: "", lighting: "", colorAnchor: "" });
}
function validate(fields: PreviewGlobalFields): void {
  if (!fields || typeof fields !== "object" || Object.keys(fields).length !== keys.length
    || keys.some(key => typeof fields[key] !== "string" || fields[key].length > MAX_PREVIEW_GLOBAL_CHARS)
    || Object.keys(fields).some(key => !keys.includes(key as keyof PreviewGlobalFields))) throw new Error("临时预览字段无效，每项最多 2000 个字符。");
}
export function updatePreviewGlobalField(fields: PreviewGlobalFields, key: keyof PreviewGlobalFields, value: string): Readonly<PreviewGlobalFields> {
  validate(fields);
  if (!keys.includes(key) || typeof value !== "string" || value.length > MAX_PREVIEW_GLOBAL_CHARS) throw new Error("临时预览字段无效，每项最多 2000 个字符。");
  return Object.freeze({ tone: fields.tone, lighting: fields.lighting, colorAnchor: fields.colorAnchor, [key]: value });
}
/** Only supplied nonblank global fields stop being listed as unavailable. Other gaps and the
 * current canFill:false remain: this is NOT automatic completeness or submission authorization. */
export function getPreviewTemplateInputGaps(workspace: TaskWorkspace, kind: PromptKind, shotId: string | null, fields: PreviewGlobalFields) {
  validate(fields);
  const summary = getTemplateInputGaps(workspace, kind, shotId);
  return Object.freeze({ ...summary, gaps: Object.freeze(summary.gaps.filter(gap => !(gap.scope === "global"
    && gap.category === "field-unavailable" && keys.includes(gap.code as keyof PreviewGlobalFields)
    && fields[gap.code as keyof PreviewGlobalFields].trim()))) });
}
