/** Local guidance for one operator-confirmed video at a time. This cannot submit,
 * reserve a slot, resume a queue, or verify a platform result. */
export const VIDEO_QUEUE_COOLDOWN_MS = 30_000;

export type PreviousVideoState =
  | { state: "history-unverified" }
  | { state: "verified-empty" }
  | { state: "active" }
  | { state: "outcome-unverified" }
  | { state: "verification-required" }
  | { state: "terminal-observed"; observedAtMs: number };

export type VideoQueueGuidance =
  | { status: "review-next-manually" }
  | { status: "wait-active" }
  | { status: "wait-cooldown"; remainingMs: number }
  | { status: "reconcile-original" }
  | { status: "pause-for-verification" };

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Caller must supply a single trusted, global snapshot (not per-account) and read
 * a trusted monotonic clock from the same epoch as the terminal observation.
 * The caller must invalidate snapshots after restart/reset or known discontinuity.
 * This stateless check only detects values older than the supplied observation. */
export function videoQueueGuidance(previous: PreviousVideoState, nowMs: number): VideoQueueGuidance {
  switch (previous?.state) {
    case "verification-required": return { status: "pause-for-verification" };
    case "active": return { status: "wait-active" };
    case "verified-empty":
      return { status: isTimestamp(nowMs) ? "review-next-manually" : "reconcile-original" };
    case "terminal-observed": {
      const observedAtMs = previous.observedAtMs;
      if (!isTimestamp(nowMs) || !isTimestamp(observedAtMs) || observedAtMs > nowMs) {
        return { status: "reconcile-original" };
      }
      const remainingMs = VIDEO_QUEUE_COOLDOWN_MS - (nowMs - observedAtMs);
      return remainingMs > 0
        ? { status: "wait-cooldown", remainingMs }
        : { status: "review-next-manually" };
    }
    default: return { status: "reconcile-original" };
  }
}
