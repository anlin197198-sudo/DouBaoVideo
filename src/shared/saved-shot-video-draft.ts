import type { InspectionSaveState } from "./inspection-summary";
import type { TaskWorkspace } from "./models";
import { editPrompt, findPrompt, promptInput, type PlanStyleContext } from "./prompts";
import { getSavedShotSummary } from "./saved-shot-summary";

export const VIDEO_PROMPT_MAX = 100000;
export interface SavedShotVideoContext {
  taskId: string;
  revision: number;
  workspace: TaskWorkspace;
  plan: PlanStyleContext;
  saveState: InspectionSaveState;
}
export type SavedShotVideoDraft = Readonly<{ source: string; text: string }>;
export type ApplySavedShotVideoDraft = (draft: SavedShotVideoDraft, text: string) => boolean;

/** Prepare verbatim saved shot bodies. State labels are not production instructions. */
export function prepareSavedShotVideoDraft({taskId, revision, workspace, plan, saveState}: SavedShotVideoContext) {
  const summary = getSavedShotSummary(workspace, plan, revision, saveState);
  if (summary.status !== "saved-local-only") return {status: "blocked", reason: "unsaved"} as const;
  if (summary.sections.length === 0 || summary.sections.some(section => section.text === null)) {
    return {status: "blocked", reason: "incomplete"} as const;
  }
  const target = findPrompt(workspace, "video", null);
  if (target?.text !== undefined && target.text !== "") return {status: "blocked", reason: "occupied"} as const;
  const videoInput = promptInput(workspace, plan, "video", null);
  if (target && target.inputSnapshot !== videoInput) return {status: "blocked", reason: "target-stale"} as const;
  const text = summary.sections.map(section => section.text!).join("\n\n");
  if (text.length > VIDEO_PROMPT_MAX) return {status: "blocked", reason: "too-long"} as const;
  return {status: "ready", draft: Object.freeze({
    source: JSON.stringify([taskId, revision, videoInput, summary.sections.map(s => [s.shotId, s.version]), target?.version ?? null]), text,
  })} as const;
}

/** The canvas calls this with live autosave state. No save or explicit review is implied. */
export function applySavedShotVideoDraft(context: SavedShotVideoContext, draft: SavedShotVideoDraft, text: string): TaskWorkspace | null {
  if (typeof text !== "string" || !text.trim() || text.length > VIDEO_PROMPT_MAX) return null;
  const current = prepareSavedShotVideoDraft(context);
  if (current.status !== "ready" || current.draft.source !== draft.source || current.draft.text !== draft.text) return null;
  return editPrompt(context.workspace, context.plan, "video", null, text);
}
