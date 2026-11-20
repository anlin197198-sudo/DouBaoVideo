import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { probeFirstPresentedVideoFrame, type ProbeVideo } from "../src/renderer/src/media/native-video-frame-probe";

const url = "app://video/550e8400-e29b-41d4-a716-446655440000";
const frame = { width: 1280, height: 720, presentedFrames: 1, mediaTime: 1 / 30 };
type Listener = () => void;
type FrameCallback = Parameters<NonNullable<ProbeVideo["requestVideoFrameCallback"]>>[0];

class FakeVideo implements ProbeVideo {
  #src = "";
  sources: string[] = [];
  plays = 0;
  pauses = 0;
  loads = 0;
  removed = 0;
  cancelled: number[] = [];
  duration = 2;
  videoWidth = 1280;
  videoHeight = 720;
  readyState = 2;
  autoplay = true;
  muted = false;
  controls = true;
  loop = true;
  playsInline = false;
  disableRemotePlayback = false;
  disablePictureInPicture = false;
  callback: FrameCallback | undefined;
  playPromise: Promise<void> | undefined;
  listeners = new Map<string, Set<Listener>>();

  get src() { return this.#src; }
  set src(value: string) { this.sources.push(value); this.#src = value; }
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  removeAttribute(_name: "src") { ++this.removed; this.#src = ""; }
  load() { ++this.loads; this.emit("abort"); }
  pause() { ++this.pauses; }
  play() { ++this.plays; return this.playPromise ?? Promise.resolve(); }
  requestVideoFrameCallback(callback: FrameCallback) { this.callback = callback; return 3; }
  cancelVideoFrameCallback(handle: number) { this.cancelled.push(handle); }
}

function assertClean(video: FakeVideo, cancelled = [3]) {
  assert.deepEqual(video.cancelled, cancelled);
  assert.equal(video.pauses, 1);
  assert.equal(video.removed, 1);
  assert.equal(video.loads, 1);
  assert.equal(video.src, "");
  assert.equal(video.listeners.get("error")?.size ?? 0, 0);
  assert.equal(video.listeners.get("abort")?.size ?? 0, 0);
}

test("F17 probe rejects protocol, host, suffix, case and deadline violations before creating video", async () => {
  let calls = 0;
  const createVideo = () => { ++calls; return new FakeVideo(); };
  for (const candidate of [
    "/local/file.mp4", "file:///private/file.mp4", "data:video/mp4;base64,AA",
    url.replace("app:", "https:"), url.replace("video", "video.example"),
    url.replace("video", "user@video"), url.replace("video", "video:443"),
    url + "\n", url + "/", url + "?x=1", url + "#x", url.toUpperCase(),
    url.replace("550", "%3550"),
  ]) assert.deepEqual(await probeFirstPresentedVideoFrame(candidate, { createVideo }), { status: "failed", reason: "invalid_capability" });
  for (const deadlineMs of [0, -1, 1.5, Infinity, 10_001])
    assert.deepEqual(await probeFirstPresentedVideoFrame(url, { deadlineMs, createVideo }), { status: "failed", reason: "invalid_deadline" });
  assert.deepEqual(await probeFirstPresentedVideoFrame(url, { createVideo, signal: AbortSignal.abort() }), { status: "failed", reason: "aborted" });
  assert.equal(calls, 0);
});

test("F17 probe turns off autoplay, presents a verified decoded frame, and releases all owned resources", async () => {
  const video = new FakeVideo();
  const abort = new AbortController();
  const pending = probeFirstPresentedVideoFrame(url, { createVideo: () => video, signal: abort.signal });
  assert.deepEqual(video.sources, [url]);
  assert.equal(video.plays, 1);
  assert.equal(video.muted, true);
  assert.equal(video.autoplay, false);
  assert.equal(video.loop, false);
  assert.equal(video.controls, false);
  assert.equal(video.disableRemotePlayback, true);
  assert.equal(video.disablePictureInPicture, true);
  assert.equal(video.playsInline, true);
  video.callback?.(0, frame);
  assert.deepEqual(await pending, { status: "first-presented-frame",
    evidence: { ...frame, durationSeconds: 2, videoWidth: 1280, videoHeight: 720 } });
  assertClean(video);
  assert.deepEqual(getEventListeners(abort.signal, "abort"), []);
  video.callback?.(0, { ...frame, presentedFrames: 2 });
  abort.abort();
  assertClean(video);
});

test("F17 metadata and resolved play alone never count as presentation; deadline cleans up", async () => {
  const video = new FakeVideo();
  const result = probeFirstPresentedVideoFrame(url, { deadlineMs: 10, createVideo: () => video });
  video.emit("loadedmetadata");
  video.emit("playing");
  assert.deepEqual(await result, { status: "failed", reason: "deadline" });
  assertClean(video);
});

test("F17 rejects invalid media dimensions, duration, position, decoded dimensions or frame count", async () => {
  for (const [setup, info] of [
    [{ duration: Infinity }, frame],
    [{ duration: 0 }, frame],
    [{ readyState: 1 }, frame],
    [{ videoWidth: 0 }, frame],
    [{ videoHeight: NaN }, frame],
    [{}, { ...frame, mediaTime: 5 }],
    [{}, { ...frame, mediaTime: -1 }],
    [{}, { ...frame, presentedFrames: 0 }],
    [{}, { ...frame, width: 0 }],
    [{}, { ...frame, height: 0 }],
  ] as const) {
    const video = new FakeVideo();
    Object.assign(video, setup);
    const result = probeFirstPresentedVideoFrame(url, { createVideo: () => video });
    video.callback?.(0, info);
    assert.deepEqual(await result, { status: "failed", reason: "invalid_frame" });
    assertClean(video);
  }
});

test("F17 abort, media failure and rejected play are distinct from success; late presentation is ignored", async () => {
  for (const way of ["signal", "error", "abort", "rejection"] as const) {
    const abort = new AbortController(), video = new FakeVideo();
    let rejectPlay: ((error: Error) => void) | undefined;
    video.playPromise = new Promise((_resolve, reject) => { rejectPlay = reject; });
    const result = probeFirstPresentedVideoFrame(url, { createVideo: () => video, signal: abort.signal });
    if (way === "signal") abort.abort(new Error("private reason"));
    else if (way === "rejection") rejectPlay?.(new Error("private reason"));
    else video.emit(way);
    assert.deepEqual(await result, { status: "failed", reason: way === "signal" ? "aborted" : "playback_failed" });
    video.callback?.(0, frame);
    assertClean(video);
    assert.deepEqual(getEventListeners(abort.signal, "abort"), []);
  }
});

test("F17 unsupported video and setup failures fail closed and trace no external input", async () => {
  const unsupported = new FakeVideo();
  Object.assign(unsupported, { requestVideoFrameCallback: undefined });
  assert.deepEqual(await probeFirstPresentedVideoFrame(url, { createVideo: () => unsupported }), { status: "failed", reason: "unsupported_frames" });
  assert.deepEqual(unsupported.sources, []);
  assert.equal(unsupported.plays, 0);
  assertClean(unsupported, []);
  const throwing = Object.assign(new FakeVideo(), { requestVideoFrameCallback: () => { throw new Error("private detail"); } });
  assert.deepEqual(await probeFirstPresentedVideoFrame(url, { createVideo: () => throwing }), { status: "failed", reason: "playback_failed" });
  assert.deepEqual(throwing.sources, []);
  assertClean(throwing, []);
});
