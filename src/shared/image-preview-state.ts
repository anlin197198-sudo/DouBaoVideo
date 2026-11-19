/** UI-only load epochs: refreshing never marks a file verified or an image ready. */
export type ImagePreviewState = Record<string, { epoch: number; status: "pending" | "ready" | "failed" }>;
export const imagePreview = (state: ImagePreviewState, id: string) => state[id] ?? { epoch: 0, status: "pending" as const };
export function refreshImagePreviews(state: ImagePreviewState, ids: string[]): ImagePreviewState {
  const next = { ...state };
  for (const id of new Set(ids)) next[id] = { epoch: imagePreview(state, id).epoch + 1, status: "pending" };
  return next;
}
export function settleImagePreview(state: ImagePreviewState, id: string, epoch: number, status: "ready" | "failed"): ImagePreviewState {
  if (imagePreview(state, id).epoch !== epoch) return state;
  return { ...state, [id]: { epoch, status } };
}
