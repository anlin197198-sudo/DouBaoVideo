import type { FrameSlot, ReferenceImage, TaskWorkspace } from "./models";
import type { PlanStyleContext } from "./prompts";
import { findPrompt } from "./prompts";
import { confirmationIssue, currentFrame, hasCurrentConfirmation } from "./frames";
import { imagePreview, type ImagePreviewState } from "./image-preview-state";
import type { SaveState } from "./workspace-autosave";

const unavailable = Object.freeze({ provider: "unavailable", login: "unavailable", free: "unavailable",
  mode: "unavailable", extraAssets: "unavailable", dispatch: "unavailable" } as const);
export type InspectionSaveState = Pick<SaveState, "dirty" | "saving" | "error" | "conflict">;
export type InspectionHiddenReason = "conflict" | "save-error" | "saving" | "dirty" | "invalid-revision";
export interface InspectionFrame {
  role: FrameSlot; candidateId: string | null; imageId: string | null;
  width: number | null; height: number | null;
  previewStatus: "missing" | "metadata-unavailable" | "pending" | "ready" | "failed";
  digest: "unavailable";
}
/** Renderer-only inspection. Save state/revision come from the existing autosave owner, not this
 * helper's own persistence check. Preview readiness is not verified bytes or submission readiness. */
export function buildInspectionSummary(workspace: TaskWorkspace, plan: PlanStyleContext, taskId: string,
  savedRevision: number, saveState: InspectionSaveState, images: ReferenceImage[], imagePreviews: ImagePreviewState) {
  const reason: InspectionHiddenReason | null = saveState.conflict ? "conflict" : saveState.error !== null ? "save-error"
    : saveState.saving ? "saving" : saveState.dirty ? "dirty"
      : !Number.isSafeInteger(savedRevision) || savedRevision < 0 ? "invalid-revision" : null;
  if (reason) return Object.freeze({ status: "hidden-unsaved" as const, reason, saved: null,
    submitted: false as const, availability: unavailable });
  const video = findPrompt(workspace, "video", null);
  const coherent = hasCurrentConfirmation(workspace, plan);
  const frames = (["first", "last"] as const).map((role): Readonly<InspectionFrame> => {
    const candidate = currentFrame(workspace, role);
    const image = candidate && images.find(item => item.id === candidate.imageId && item.taskId === taskId);
    const validDimensions = image && Number.isSafeInteger(image.width) && image.width > 0
      && Number.isSafeInteger(image.height) && image.height > 0;
    return Object.freeze({ role, candidateId: candidate?.id ?? null, imageId: candidate?.imageId ?? null,
      width: validDimensions ? image.width : null, height: validDimensions ? image.height : null,
      previewStatus: !candidate ? "missing" : !validDimensions ? "metadata-unavailable" : imagePreview(imagePreviews, candidate.imageId).status,
      digest: "unavailable" });
  });
  return Object.freeze({ status: "saved-local-only" as const, submitted: false as const, availability: unavailable,
    saved: Object.freeze({ taskId, revision: savedRevision,
      video: video ? Object.freeze({ text: video.text, version: video.version }) : null,
      confirmation: Object.freeze({ coherent, confirmedAt: coherent ? workspace.frames!.confirmation!.confirmedAt : null,
        issue: confirmationIssue(workspace, plan)?.message ?? (coherent ? null : "首尾图片尚未按当前输入确认。") }),
      frames: Object.freeze(frames) }) });
}
