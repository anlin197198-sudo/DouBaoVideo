const EXACT_VIDEO_CAPABILITY_URL = /^app:\/\/video\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_DEADLINE_MS = 4_000;
const MAX_DEADLINE_MS = 10_000;
const HAVE_CURRENT_DATA = 2;

type Frame = Pick<VideoFrameCallbackMetadata, "presentedFrames" | "mediaTime" | "width" | "height">;
type MediaListener = () => void;
export interface ProbeVideo {
  src: string;
  muted: boolean;
  autoplay: boolean;
  controls: boolean;
  loop: boolean;
  playsInline: boolean;
  disableRemotePlayback: boolean;
  disablePictureInPicture: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly duration: number;
  readonly readyState: number;
  addEventListener(type: "error" | "abort", listener: MediaListener): void;
  removeEventListener(type: "error" | "abort", listener: MediaListener): void;
  removeAttribute(name: "src"): void;
  load(): void;
  pause(): void;
  play(): Promise<void>;
  requestVideoFrameCallback?(callback: (now: number, frame: Frame) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

type ProbeFailure =
  | "invalid_capability" | "invalid_deadline" | "aborted" | "deadline"
  | "unsupported_frames" | "invalid_frame" | "playback_failed";
export type NativeVideoProbeResult =
  | { status: "first-presented-frame"; evidence: Readonly<Frame & { durationSeconds: number; videoWidth: number; videoHeight: number }> }
  | { status: "failed"; reason: ProbeFailure };

export interface NativeVideoProbeOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Supply a fresh element. The production default creates a detached video with no visible UI. */
  createVideo?: () => ProbeVideo;
}

const positiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;
const fail = (reason: ProbeFailure): NativeVideoProbeResult => ({ status: "failed", reason });

/** Internal renderer-only probe. A success observes one presented frame, not whole-file integrity. */
export function probeFirstPresentedVideoFrame(url: string, options: NativeVideoProbeOptions = {}): Promise<NativeVideoProbeResult> {
  if (typeof url !== "string" || !EXACT_VIDEO_CAPABILITY_URL.test(url) || url.length !== 48)
    return Promise.resolve(fail("invalid_capability"));
  const { signal, deadlineMs = DEFAULT_DEADLINE_MS } = options;
  if (!positiveInteger(deadlineMs) || deadlineMs > MAX_DEADLINE_MS)
    return Promise.resolve(fail("invalid_deadline"));
  if (signal?.aborted) return Promise.resolve(fail("aborted"));

  let video: ProbeVideo;
  try {
    video = options.createVideo?.() ?? document.createElement("video");
  } catch {
    return Promise.resolve(fail("playback_failed"));
  }

  return new Promise(resolve => {
    let settled = false;
    let handle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bestEffort = (action: () => void) => { try { action(); } catch { /* Do not skip remaining cleanup. */ } };
    const mediaFailure = () => finish(fail("playback_failed"));
    const cancel = () => finish(fail("aborted"));

    function finish(result: NativeVideoProbeResult) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      bestEffort(() => signal?.removeEventListener("abort", cancel));
      bestEffort(() => video.removeEventListener("error", mediaFailure));
      bestEffort(() => video.removeEventListener("abort", mediaFailure));
      if (handle !== undefined) bestEffort(() => video.cancelVideoFrameCallback?.(handle!));
      bestEffort(() => video.pause());
      bestEffort(() => video.removeAttribute("src"));
      bestEffort(() => video.load());
      resolve(result);
    }

    const expires = performance.now() + deadlineMs;
    try {
      if (typeof video.requestVideoFrameCallback !== "function" || typeof video.cancelVideoFrameCallback !== "function") {
        finish(fail("unsupported_frames"));
        return;
      }
      video.muted = true;
      video.autoplay = false;
      video.controls = false;
      video.loop = false;
      video.playsInline = true;
      video.disableRemotePlayback = true;
      video.disablePictureInPicture = true;
      video.addEventListener("error", mediaFailure);
      video.addEventListener("abort", mediaFailure);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => finish(fail("deadline")), deadlineMs);
      handle = video.requestVideoFrameCallback((_now, frame) => {
        if (settled) return;
        if (signal?.aborted) { cancel(); return; }
        if (performance.now() >= expires) { finish(fail("deadline")); return; }
        try {
          const { duration: durationSeconds, videoWidth, videoHeight, readyState } = video;
          const { mediaTime, presentedFrames, width, height } = frame;
          if (!(Number.isFinite(durationSeconds) && durationSeconds > 0 &&
            positiveInteger(videoWidth) && positiveInteger(videoHeight) &&
            readyState >= HAVE_CURRENT_DATA && positiveInteger(presentedFrames) &&
            Number.isFinite(mediaTime) && mediaTime >= 0 && mediaTime <= durationSeconds &&
            positiveInteger(width) && positiveInteger(height))) {
            finish(fail("invalid_frame"));
            return;
          }
          finish({ status: "first-presented-frame", evidence: Object.freeze({
            durationSeconds, videoWidth, videoHeight, mediaTime, presentedFrames, width, height,
          }) });
        } catch { finish(fail("invalid_frame")); }
      });
      // Browser callbacks are asynchronous; do not start playback if an injected implementation already settled.
      if (settled) {
        bestEffort(() => video.cancelVideoFrameCallback?.(handle!));
        return;
      }
      video.src = url;
      if (!settled) void video.play().catch(mediaFailure);
    } catch {
      finish(fail("playback_failed"));
    }
  });
}
