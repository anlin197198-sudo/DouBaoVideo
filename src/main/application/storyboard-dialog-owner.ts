/** Single-dialog approval is meaningful only for the initiating window and top-level document. */
export function storyboardApprovalOwner<W extends object>(window: W, getWindow: () => W | null,
  documentEpoch: (owner: W) => number, isLive: (owner: W) => boolean): () => boolean {
  const epoch = documentEpoch(window);
  return () => getWindow() === window && isLive(window) && documentEpoch(window) === epoch;
}
