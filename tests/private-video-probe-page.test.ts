import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPrivateVideoProbeRunner, PRIVATE_VIDEO_PROBE_PAGE_URL, PRIVATE_VIDEO_PROBE_RESULT_KEY,
} from "../src/renderer/src/media/private-video-probe-page";
import type { NativeVideoProbeResult } from "../src/renderer/src/media/native-video-frame-probe";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const href = `${PRIVATE_VIDEO_PROBE_PAGE_URL}#${uuid}`;
const fail = { status: "failed", reason: "playback_failed" } as const;
const evidence = { durationSeconds: 2, videoWidth: 1280, videoHeight: 720, width: 1280, height: 720, presentedFrames: 1, mediaTime: 0 };

test("F17 private page accepts only the dedicated canonical app document and bare lowercase UUID fragment", async () => {
  let calls = 0;
  const probe = async () => { calls++; return fail; };
  for (const value of [
    PRIVATE_VIDEO_PROBE_PAGE_URL, href.replace("video-probe/", "renderer/"),
    href.replace("app:", "https:"), href.replace("video-probe/", "video-probe.external/"),
    href.replace("video-probe/", "user@video-probe/"), href.replace("video-probe/", "video-probe:443/"),
    href.replace(".html#", ".html?#"), href.replace(".html#", ".html?token=x#"),
    href.replace(".html#", ".HTML#"), href.replace(".html#", ".html/extra#"),
    href.replace("#55", "#%355"), href.replace(uuid, uuid.toUpperCase()),
    href + "\n", href + "#", href + "/", href + "?x=1",
  ]) {
    const run = createPrivateVideoProbeRunner(probe);
    assert.deepEqual(await run(value), { status: "failed", reason: "invalid_page" });
    assert.equal(await run(href), null, "invalid first invocation also burns the document run");
  }
  assert.equal(calls, 0);
});

test("F17 private renderer derives one app-only media capability and publishes only frozen numeric evidence", async () => {
  let calls = 0;
  const controller = new AbortController();
  const run = createPrivateVideoProbeRunner(async (url, options) => {
    calls++;
    assert.equal(url, `app://video/${uuid}`);
    assert.equal(options?.signal, controller.signal);
    return { status: "first-presented-frame", evidence: { ...evidence, url, pathname: "C:/private/x.mp4" } };
  });

  const [first, second] = await Promise.all([run(href, controller.signal), run(href, controller.signal)]);
  assert.equal(calls, 1);
  assert.equal(second, null);
  assert.deepEqual(first, { status: "first-presented-frame", evidence });
  assert(first && Object.isFrozen(first));
  assert(first.status === "first-presented-frame" && Object.isFrozen(first.evidence));
  assert.doesNotMatch(JSON.stringify(first), /app:\/\/|550e|private\/x/);
});

test("F17 private renderer does not expose exception strings, unknown failure details, failed proof or aborted effects", async () => {
  const error = await createPrivateVideoProbeRunner(async () => { throw Error(href); })(href);
  assert.deepEqual(error, fail);
  for (const reply of [
    { status: "failed", reason: href },
    { status: "failed", reason: "deadline", token: uuid },
    { status: "first-presented-frame", evidence: { ...evidence, width: 0 } },
    { status: "first-presented-frame", evidence: { ...evidence, durationSeconds: Infinity } },
    { status: "first-presented-frame", evidence: { ...evidence, mediaTime: 9 } },
  ]) {
    const output = await createPrivateVideoProbeRunner(async () => reply as NativeVideoProbeResult)(href);
    assert.deepEqual(Object.keys(output ?? {}).sort(), ["reason", "status"]);
    assert.equal(output?.status, "failed");
    assert.doesNotMatch(JSON.stringify(output), /app:\/\/|550e/);
  }

  let calls = 0;
  const alreadyAborted = createPrivateVideoProbeRunner(async () => { ++calls; return fail; });
  assert.deepEqual(await alreadyAborted(href, AbortSignal.abort(uuid)), { status: "failed", reason: "aborted" });
  assert.equal(calls, 0);

  const controller = new AbortController();
  const cancelDuringProbe = createPrivateVideoProbeRunner(async () => {
    controller.abort(href);
    return { status: "first-presented-frame", evidence };
  });
  assert.deepEqual(await cancelDuringProbe(href, controller.signal), { status: "failed", reason: "aborted" });
});

test("F17 private shard has only one module entry and a restrictive CSP; readout is a fixed private property", () => {
  const page = readFileSync(new URL("../src/renderer/f17-video-probe.html", import.meta.url), "utf8");
  const index = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const content = /content="([^"]*default-src[^"]*)"/.exec(page)?.[1];
  assert(content);
  assert.deepEqual(new Set(content.split("; ").map(part => part.trim())), new Set([
    "default-src 'none'", "script-src 'self'", "media-src app://video", "connect-src 'none'",
    "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
  ]));
  assert.equal(page.match(/<script\b/g)?.length, 1);
  assert.match(page, /<script type="module" src="\/src\/media\/private-video-probe-entry\.ts"><\/script>/);
  assert.doesNotMatch(index, /private-video-probe-entry|f17-video-probe/);
  assert.equal(PRIVATE_VIDEO_PROBE_RESULT_KEY, "__doubaoF17ProbeResult");
});
