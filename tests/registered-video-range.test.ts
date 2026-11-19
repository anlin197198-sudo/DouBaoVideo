import assert from "node:assert/strict";
import { test } from "node:test";
import { registeredVideoRange } from "../src/main/application/registered-video-range";

test("registered film range selects exact inclusive byte windows for full playback and seeks", () => {
  assert.deepEqual(registeredVideoRange(null, 10), { kind: "full", start: 0, end: 9, length: 10 });
  for (const [header, start, end] of [
    ["bytes=0-0", 0, 0], ["bytes=4-", 4, 9], ["bytes=-2", 8, 9], ["Bytes=3-6", 3, 6],
    ["bytes=9-999999999999999999999999", 9, 9], ["bytes=-999999999999999999999999", 0, 9],
  ] as const) {
    assert.deepEqual(registeredVideoRange(header, 10), {
      kind: "partial", start, end, length: end - start + 1, contentRange: `bytes ${start}-${end}/10`,
    }, header);
  }
});

test("registered film range rejects ambiguous, excessive, invalid and unsatisfiable reads", () => {
  for (const header of [
    "", "bytes=", "bytes=-", "bytes=-0", "bytes=10-", "bytes=3-2", "bytes=1-2,5-9",
    "bytes=+1-3", "bytes=1-5\n", "bytes =1-3", "bytes=1.5-3", "items=1-2", "bytes=" + "1".repeat(100) + "-",
  ]) {
    assert.deepEqual(registeredVideoRange(header, 10), { kind: "unsatisfiable", contentRange: "bytes */10" }, header);
  }
  for (const size of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(registeredVideoRange("bytes=0-0", size), { kind: "invalid-file" });
  }
  assert.deepEqual(registeredVideoRange("bytes=9007199254740990-9007199254740999", Number.MAX_SAFE_INTEGER),
    { kind: "partial", start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER - 1, length: 1,
      contentRange: "bytes 9007199254740990-9007199254740990/9007199254740991" });
});
