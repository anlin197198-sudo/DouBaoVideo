import assert from "node:assert/strict";
import test from "node:test";
import { videoQueueGuidance, type PreviousVideoState } from "../src/shared/video-queue-guidance";

test("F14 only verified empty history can show the first manual review", () => {
  assert.deepEqual(videoQueueGuidance({ state: "verified-empty" }, 0), { status: "review-next-manually" });
  assert.deepEqual(videoQueueGuidance({ state: "history-unverified" }, 50_000), { status: "reconcile-original" });
});

test("F14 submitting/generating or an uncertain outcome never releases the global video slot by time alone", () => {
  const now = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(videoQueueGuidance({ state: "active" }, now), { status: "wait-active" });
  assert.deepEqual(videoQueueGuidance({ state: "outcome-unverified" }, now), { status: "reconcile-original" });
});

test("F14 next manual review waits 30 seconds measured after the observed terminal result", () => {
  const last = { state: "terminal-observed", observedAtMs: 2_000 } as const;
  assert.deepEqual(videoQueueGuidance(last, 2_000), { status: "wait-cooldown", remainingMs: 30_000 });
  assert.deepEqual(videoQueueGuidance(last, 31_999), { status: "wait-cooldown", remainingMs: 1 });
  assert.deepEqual(videoQueueGuidance(last, 32_000), { status: "review-next-manually" });
  assert.deepEqual(videoQueueGuidance(last, 32_001), { status: "review-next-manually" });
});

test("F14 verification cannot be cleared by a clock or malformed snapshot", () => {
  for (const now of [0, 60_000, Number.MAX_SAFE_INTEGER, NaN]) {
    assert.deepEqual(videoQueueGuidance({ state: "verification-required" }, now), { status: "pause-for-verification" });
  }
  for (const previous of [null, {}, { state: "unexpected" }]) {
    assert.deepEqual(videoQueueGuidance(previous as PreviousVideoState, 60_000), { status: "reconcile-original" });
  }
});

test("F14 invalid timestamps, future timestamps and clock rollback fail closed", () => {
  const bad = [undefined, NaN, Infinity, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1];
  for (const time of bad) {
    assert.deepEqual(videoQueueGuidance({ state: "terminal-observed", observedAtMs: time as number }, 60_000), { status: "reconcile-original" });
    assert.deepEqual(videoQueueGuidance({ state: "verified-empty" }, time as number), { status: "reconcile-original" });
  }
  assert.deepEqual(videoQueueGuidance({ state: "terminal-observed", observedAtMs: 2_000 }, 1_999), { status: "reconcile-original" });
});
