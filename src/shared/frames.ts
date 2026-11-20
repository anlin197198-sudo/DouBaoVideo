import type { PlanStyleContext } from "./prompts";
import type { FrameCandidate, FrameSlot, FrameWorkspace, Plan, TaskWorkspace } from "./models";
import { findPrompt, promptInput } from "./prompts";

export function frameState(workspace: TaskWorkspace): FrameWorkspace {
  return workspace.frames ?? { candidates: [], firstId: null, lastId: null,
    parameters: { aspectRatio: "16:9", durationSeconds: 5 }, confirmation: null };
}
export function currentFrame(workspace: TaskWorkspace, slot: FrameSlot) {
  const frames = frameState(workspace);
  return frames.candidates.find(candidate => candidate.id === (slot === "first" ? frames.firstId : frames.lastId) && candidate.slot === slot);
}
/** Informational only: compare candidate provenance to current input for its own role. */
export function frameCandidateHasOlderInput(workspace: TaskWorkspace, plan: PlanStyleContext, candidate: FrameCandidate): boolean {
  const kind = candidate.slot === "first" ? "firstFrame" : "lastFrame";
  return candidate.inputSnapshot !== promptInput(workspace, plan, kind, null)
    || candidate.promptText !== (findPrompt(workspace, kind, null)?.text ?? "");
}
export function addFrameCandidate(workspace: TaskWorkspace, planStyle: PlanStyleContext, slot: FrameSlot, imageId: string, id: string, now: string, savedInputs = true): TaskWorkspace {
  const frames = frameState(workspace), kind = slot === "first" ? "firstFrame" : "lastFrame";
  if (frames.candidates.length >= 100) throw new Error("最多保留 100 个候选，请先移除不需要的候选。");
  if (frames.candidates.some(candidate => candidate.id === id)) return workspace;
  const prompt = findPrompt(workspace, kind, null);
  return { ...workspace, frames: { ...frames, candidates: [...frames.candidates, { id, imageId, slot, source: "import", createdAt: now,
    promptText: prompt?.text ?? "", promptVersion: savedInputs ? prompt?.version ?? null : null, inputSnapshot: promptInput(workspace, planStyle, kind, null) }] } };
}
export function chooseFrame(workspace: TaskWorkspace, slot: FrameSlot, id: string | null): TaskWorkspace {
  const frames = frameState(workspace);
  if (id && !frames.candidates.some(candidate => candidate.id === id && candidate.slot === slot)) throw new Error("候选图片不属于这个位置。");
  const key = slot === "first" ? "firstId" : "lastId";
  if (frames[key] === id) return workspace;
  return { ...workspace, frames: { ...frames, [key]: id,
    confirmation: frames.confirmation ? { ...frames.confirmation, invalidated: true } : null } };
}
export function confirmationInput(workspace: TaskWorkspace, planStyle: PlanStyleContext): string {
  const frames = frameState(workspace);
  return JSON.stringify({ first: currentFrame(workspace, "first"), last: currentFrame(workspace, "last"), parameters: frames.parameters,
    video: findPrompt(workspace, "video", null)?.text ?? "", videoInput: promptInput(workspace, planStyle, "video", null),
    videoPromptVersion: findPrompt(workspace, "video", null)?.version ?? null,
    firstPrompt: findPrompt(workspace, "firstFrame", null)?.text ?? "", lastPrompt: findPrompt(workspace, "lastFrame", null)?.text ?? "" });
}
export type ReviewPromptKind = "video" | "firstFrame" | "lastFrame";
export interface ConfirmationIssue { message: string; promptKind?: ReviewPromptKind; actionLabel?: string }
export function confirmationIssue(workspace: TaskWorkspace, planStyle: PlanStyleContext): ConfirmationIssue | null {
  if (!currentFrame(workspace, "first") || !currentFrame(workspace, "last")) return { message: "请先分别选择首帧和尾帧。" };
  const video = findPrompt(workspace, "video", null);
  if (!video?.text.trim()) return { message: "请先填写视频提示词。", promptKind: "video", actionLabel: "去填写视频提示词" };
  if (video.inputSnapshot !== promptInput(workspace, planStyle, "video", null)) return { message: "视频提示词输入已变化，请先核对。", promptKind: "video", actionLabel: "去核对视频提示词" };
  for (const kind of ["firstFrame", "lastFrame"] as const) {
    const prompt = findPrompt(workspace, kind, null);
    if (prompt && prompt.inputSnapshot !== promptInput(workspace, planStyle, kind, null)) {
      const name = kind === "firstFrame" ? "首帧" : "尾帧";
      return { message: name + "图片提示词输入已变化，请先核对。", promptKind: kind, actionLabel: "去核对" + name + "提示词" };
    }
  }
  return null;
}
export function confirmationBlocker(workspace: TaskWorkspace, planStyle: PlanStyleContext): string | null {
  return confirmationIssue(workspace, planStyle)?.message ?? null;
}
export function hasCurrentConfirmation(workspace: TaskWorkspace, planStyle: PlanStyleContext): boolean {
  const confirmation = workspace.frames?.confirmation;
  return !!confirmation && !confirmation.invalidated && !confirmationBlocker(workspace, planStyle)
    && confirmation.inputSnapshot === confirmationInput(workspace, planStyle);
}

/** Remember any meaningful editor change even if it is reverted before debounce saves. */
export function invalidateChangedConfirmation(previous: TaskWorkspace, next: TaskWorkspace, plan: PlanStyleContext): TaskWorkspace {
  const confirmation = previous.frames?.confirmation;
  if (!confirmation || !next.frames) return next;
  if (confirmation.invalidated || next.frames.confirmation?.invalidated
    || confirmationInput(previous, plan) !== confirmationInput(next, plan)) {
    return { ...next, frames: { ...next.frames, confirmation: { ...confirmation, invalidated: true } } };
  }
  return next;
}
