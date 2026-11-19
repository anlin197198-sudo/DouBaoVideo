import type { PromptHistoryDetail, PromptKind, TaskWorkspace } from "./models";
import { confirmationInput } from "./frames";
import { findPrompt, promptInput, type PlanStyleContext } from "./prompts";

export interface PromptRestorePreview {
  fingerprint: string; kind: PromptKind; shotId: string | null; historyVersion: number;
  text: string; inputSnapshot: string; changed: boolean;
}
function validateTarget(w: TaskWorkspace, kind: PromptKind, shotId: string | null) {
  if (!["shot", "video", "firstFrame", "lastFrame"].includes(kind)
    || (kind === "shot" ? typeof shotId !== "string" || !w.shots.some(shot => shot.id === shotId) : shotId !== null))
    throw new Error("提示词类型或镜头已变化，请重新打开历史版本。");
}
function validateContent(text: string, inputSnapshot: string, version: number) {
  if (typeof text !== "string" || text.length > 100000 || typeof inputSnapshot !== "string" || inputSnapshot.length > 10000000
    || !Number.isSafeInteger(version) || version < 1) throw new Error("历史提示词内容或版本无效。");
}
function fingerprint(w: TaskWorkspace, plan: PlanStyleContext, kind: PromptKind, shotId: string | null) {
  return JSON.stringify({ kind, shotId, current: findPrompt(w, kind, shotId) ?? null,
    dependencies: promptInput(w, plan, kind, shotId), confirmationInput: confirmationInput(w, plan), confirmation: w.frames?.confirmation ?? null });
}

/** Detail must come from the caller's task/kind/shot-scoped history read. Never bless historical inputs as current. */
export function previewPromptRestore(w: TaskWorkspace, plan: PlanStyleContext, kind: PromptKind, shotId: string | null, detail: PromptHistoryDetail): PromptRestorePreview {
  validateTarget(w, kind, shotId); validateContent(detail.text, detail.inputSnapshot, detail.version);
  const current = findPrompt(w, kind, shotId);
  return Object.freeze({ fingerprint: fingerprint(w, plan, kind, shotId), kind, shotId, historyVersion: detail.version,
    text: detail.text, inputSnapshot: detail.inputSnapshot,
    changed: !current || current.text !== detail.text || current.inputSnapshot !== detail.inputSnapshot });
}

/** Applies only the approved prompt payload. The normal save creates a new immutable version. */
export function applyPromptRestore(w: TaskWorkspace, plan: PlanStyleContext, preview: PromptRestorePreview): TaskWorkspace {
  validateTarget(w, preview.kind, preview.shotId); validateContent(preview.text, preview.inputSnapshot, preview.historyVersion);
  if (fingerprint(w, plan, preview.kind, preview.shotId) !== preview.fingerprint)
    throw new Error("提示词、相关输入或图片审核已变化，请重新预览并确认。");
  const current = findPrompt(w, preview.kind, preview.shotId);
  if (current?.text === preview.text && current.inputSnapshot === preview.inputSnapshot) return w;
  const prompt = { kind: preview.kind, shotId: preview.shotId, text: preview.text, inputSnapshot: preview.inputSnapshot,
    version: current?.version ?? 1, source: "manual" as const };
  return { ...w, ...(w.frames?.confirmation ? { frames: { ...w.frames, confirmation: { ...w.frames.confirmation, invalidated: true } } } : {}),
    prompts: current ? w.prompts!.map(item => item === current ? prompt : item) : [...(w.prompts ?? []), prompt] };
}
