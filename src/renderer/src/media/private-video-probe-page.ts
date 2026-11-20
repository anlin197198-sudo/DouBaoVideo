import { probeFirstPresentedVideoFrame, type NativeVideoProbeResult } from "./native-video-frame-probe";

export const PRIVATE_VIDEO_PROBE_PAGE_URL = "app://video-probe/f17-video-probe.html";
export const PRIVATE_VIDEO_PROBE_RESULT_KEY = "__doubaoF17ProbeResult";
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pagePrefix = `${PRIVATE_VIDEO_PROBE_PAGE_URL}#`;

type Evidence = Extract<NativeVideoProbeResult, { status: "first-presented-frame" }>["evidence"];
type Failure = Extract<NativeVideoProbeResult, { status: "failed" }>["reason"] | "invalid_page";
export type PrivateVideoProbeResult =
  | Readonly<{ status: "first-presented-frame"; evidence: Evidence }>
  | Readonly<{ status: "failed"; reason: Failure }>;

const knownFailures: ReadonlySet<string> = new Set<Failure>([
  "aborted", "deadline", "unsupported_frames", "invalid_frame", "playback_failed",
  "invalid_capability", "invalid_deadline",
]);
const positiveInt = (value: number) => Number.isSafeInteger(value) && value > 0;
const fail = (reason: Failure): PrivateVideoProbeResult => Object.freeze({ status: "failed", reason });

function mediaCapabilityFromPage(pageHref: string): string | null {
  if (!pageHref.startsWith(pagePrefix)) return null;
  const token = pageHref.slice(pagePrefix.length);
  return token.length === 36 && tokenPattern.test(token) ? `app://video/${token}` : null;
}

function sanitizeResult(reply: NativeVideoProbeResult): PrivateVideoProbeResult {
  if (reply.status === "failed") return fail(knownFailures.has(reply.reason) ? reply.reason : "playback_failed");
  if (reply.status !== "first-presented-frame") return fail("playback_failed");
  const { durationSeconds, videoWidth, videoHeight, width, height, mediaTime, presentedFrames } = reply.evidence;
  if (!(Number.isFinite(durationSeconds) && durationSeconds > 0 &&
    Number.isFinite(mediaTime) && mediaTime >= 0 && mediaTime <= durationSeconds &&
    [videoWidth, videoHeight, width, height, presentedFrames].every(positiveInt))) {
    return fail("invalid_frame");
  }
  return Object.freeze({ status: "first-presented-frame",
    evidence: Object.freeze({ durationSeconds, videoWidth, videoHeight, width, height, mediaTime, presentedFrames }),
  });
}

/** One document, one invocation, no public IPC. Host is still responsible for document ownership and revocation. */
export function createPrivateVideoProbeRunner(probe = probeFirstPresentedVideoFrame) {
  let started = false;
  return async (pageHref: string, signal?: AbortSignal): Promise<PrivateVideoProbeResult | null> => {
    if (started) return null;
    started = true;
    const capability = mediaCapabilityFromPage(pageHref);
    if (!capability) return fail("invalid_page");
    if (signal?.aborted) return fail("aborted");
    try {
      const reply = await probe(capability, { signal });
      return signal?.aborted ? fail("aborted") : sanitizeResult(reply);
    } catch {
      return fail(signal?.aborted ? "aborted" : "playback_failed");
    }
  };
}
