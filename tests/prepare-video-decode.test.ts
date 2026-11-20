import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createVideoDecodePreparation } from "../src/main/application/prepare-video-decode";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";

function box(type: string, payload: Buffer) {
  const heading = Buffer.alloc(8);
  heading.writeUInt32BE(8 + payload.length);
  heading.write(type, 4, "ascii");
  return Buffer.concat([heading, payload]);
}
const bytes = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", Buffer.from("synthetic")),
  box("mdat", Buffer.alloc(74_000, 53))]);
const positive = { status: "first-presented-frame", evidence: { durationSeconds: 1.25, videoWidth: 8, videoHeight: 6,
  mediaTime: 0.1, presentedFrames: 1, width: 8, height: 6 } };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "doubao-decode-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.mp4"), stagingParent = join(root, "stage");
  await mkdir(stagingParent);
  await writeFile(sourcePath, bytes);
  const owner = { ownerId: 17, documentId: randomUUID() };
  let now = 1, live = true;
  const registry = new VideoProbeRegistry({ isLive: (id, doc) => live && id === owner.ownerId && doc === owner.documentId,
    now: () => now, ttlMs: 10 });
  const get = (url: string, range?: string, requestOwner = owner) => registry.response({ url, method: "GET",
    headers: new Headers(range ? { range } : {}) }, requestOwner);
  return { owner, stagingParent, sourcePath, registry, get, expire: () => { now = 11; }, leave: () => { live = false; },
    intake: async () => intakeMp4(sourcePath, await lstat(sourcePath)) };
}

test("decode preparation hands exact staged capability to trusted host and returns bound positive frame facts", async t => {
  const f = await fixture(t);
  let issued = "", probeAborted = false, requestedRanges = 0;
  const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
    async probe(url, owner, signal) {
      issued = url;
      signal.addEventListener("abort", () => { probeAborted = true; });
      assert.deepEqual(owner, f.owner);
      assert.ok(Object.isFrozen(owner));
      assert.equal(Object.keys(owner).length, 2);
      assert.equal((await f.get(url, undefined, { ...owner, documentId: randomUUID() })).status, 404);
      for (const [start, end] of [[0, 17], [19, 70_000]] as const) {
        const response = await f.get(url, `bytes=${start}-${end}`);
        assert.equal(response.status, 206);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
        requestedRanges++;
      }
      return positive;
    } });
  const input = await f.intake();
  let opens = 0, closes = 0;
  const result = await prepare({ ...input, stream() { opens++; return input.stream(); },
    async close() { closes++; await input.close(); } }, f.owner);
  assert.deepEqual(result, { status: "first-frame-observed", cleanup: "removed",
    fingerprint: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, evidence: positive.evidence });
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.equal(requestedRanges, 2);
  assert.ok(probeAborted);
  assert.equal((await f.get(issued)).status, 404);
  assert.deepEqual(await readdir(f.stagingParent), []);
  assert.deepEqual(await readFile(f.sourcePath), bytes);
});

test("decode preparation rejects malformed, unconsumed, expired and revoked positive replies", async t => {
  for (const mode of ["metadata", "no-read", "bad-frame", "expiry", "invalidated", "owner-left"] as const) {
    const f = await fixture(t);
    let issued = "";
    const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
      async probe(url) {
        issued = url;
        if (mode === "no-read") return positive;
        const reply = await f.get(url, "bytes=0-15");
        assert.equal(reply.status, 206);
        await reply.arrayBuffer();
        if (mode === "metadata") return { status: "loadedmetadata", evidence: positive.evidence };
        if (mode === "bad-frame") return { ...positive, evidence: { ...positive.evidence, mediaTime: 2 } };
        if (mode === "expiry") f.expire();
        if (mode === "invalidated") f.registry.invalidateOwner(f.owner.ownerId);
        if (mode === "owner-left") f.leave();
        return positive;
      } });
    assert.deepEqual(await prepare(await f.intake(), f.owner), { status: "probe-rejected", cleanup: "removed", inputCloseConfirmed: true }, mode);
    assert.equal((await f.get(issued)).status, 404, mode);
    assert.deepEqual(await readdir(f.stagingParent), [], mode);
  }
});

test("cancel/deadline do not wait for late host evidence and revoke and discard open byte streams", async t => {
  for (const mode of ["cancel", "deadline"] as const) {
    const f = await fixture(t), abort = new AbortController();
    let late!: (value: unknown) => void, issued = "";
    let ready!: () => void, response: Response | undefined;
    const entered = new Promise<void>(resolve => ready = resolve);
    const reply = new Promise<unknown>(resolve => late = resolve);
    const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
      deadlineMs: 500,
      async probe(url) { issued = url; response = await f.get(url); ready(); return reply; } });
    const pending = prepare(await f.intake(), f.owner, abort.signal);
    await entered;
    assert.equal(response?.status, 200);
    if (mode === "cancel") abort.abort();
    assert.deepEqual(await pending, { status: mode === "cancel" ? "cancelled" : "deadline", cleanup: "removed", inputCloseConfirmed: true });
    late(positive);
    assert.equal((await f.get(issued)).status, 404);
    await assert.rejects(response!.arrayBuffer());
    assert.deepEqual(await readdir(f.stagingParent), []);
  }
});

test("uncertain stage removal or intake close suppresses positive evidence", async t => {
  for (const mode of ["stage-changed", "input-close"] as const) {
    const f = await fixture(t);
    const input = await f.intake();
    let issued = "";
    const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
      async probe(url) {
        issued = url;
        const response = await f.get(url, "bytes=0-15");
        assert.equal(response.status, 206);
        await response.arrayBuffer();
        if (mode === "stage-changed") {
          const [candidate] = await readdir(f.stagingParent);
          assert.ok(candidate);
          await writeFile(join(f.stagingParent, candidate), "foreign bytes");
        }
        return positive;
      } });
    const chosen = mode === "input-close" ? { ...input, async close() {
      await input.close();
      throw new Error("private detail");
    } } : input;
    assert.deepEqual(await prepare(chosen, f.owner), { status: "cleanup-unconfirmed",
      cleanup: mode === "stage-changed" ? "retained-or-unknown" : "removed", inputCloseConfirmed: mode !== "input-close" });
    assert.equal((await f.get(issued)).status, 404);
    assert.equal((await readdir(f.stagingParent)).length, mode === "stage-changed" ? 1 : 0);
    assert.deepEqual(await readFile(f.sourcePath), bytes);
  }
});

test("opt-in handoff revokes token, awaits positive native stop, then yields exact staged bytes once", async t => {
  const f = await fixture(t);
  let issued = "", releaseStop!: (value: boolean) => void, stopEntered!: () => void;
  const stopped = new Promise<boolean>(resolve => { releaseStop = resolve; });
  const entered = new Promise<void>(resolve => { stopEntered = resolve; });
  let consumeCount = 0, openLater: (() => Promise<unknown>) | undefined;
  const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
    async probe(url) {
      issued = url;
      const response = await f.get(url, "bytes=4-19");
      assert.equal(response.status, 206);
      await response.arrayBuffer();
      return positive;
    },
    async stopProbe() {
      assert.equal((await f.get(issued)).status, 404);
      stopEntered();
      return stopped;
    },
  });
  const work = prepare(await f.intake(), f.owner, undefined, {
    isCurrent: () => true,
    async consume(snapshot) {
      consumeCount++;
      assert.deepEqual(Object.keys(snapshot).sort(), ["fingerprint", "open"]);
      assert.equal(snapshot.fingerprint.sha256, createHash("sha256").update(bytes).digest("hex"));
      openLater = snapshot.open;
      const body = await snapshot.open();
      await assert.rejects(snapshot.open());
      assert.deepEqual(Buffer.from(await new Response(body).arrayBuffer()), bytes);
    },
  });
  await entered;
  assert.equal(consumeCount, 0);
  releaseStop(true);
  assert.equal((await work).status, "first-frame-observed");
  assert.equal(consumeCount, 1);
  await assert.rejects(openLater!());
  assert.equal((await f.get(issued)).status, 404);
  assert.deepEqual(await readdir(f.stagingParent), []);
  assert.deepEqual(await readFile(f.sourcePath), bytes);
});

test("handoff refuses missing/uncertain stop, stale context, partial consumption, and consumer exceptions", async t => {
  for (const mode of ["missing-stop", "stop-refused", "stale", "partial", "throws", "bad-frame"] as const) {
    const f = await fixture(t);
    let consumed = false, probed = false;
    const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
      async probe(url) {
        probed = true;
        const response = await f.get(url, "bytes=0-15");
        await response.arrayBuffer();
        return mode === "bad-frame" ? { status: "loadedmetadata" } : positive;
      },
      ...(mode !== "missing-stop" ? { stopProbe: () => mode !== "stop-refused" } : {}),
    });
    const result = await prepare(await f.intake(), f.owner, undefined, {
      isCurrent: () => mode !== "stale",
      async consume(snapshot) {
        consumed = true;
        const input = (await snapshot.open()).getReader();
        assert.equal((await input.read()).done, false);
        if (mode === "throws") throw new Error("must remain private");
      },
    });
    assert.equal(result.status, mode === "stop-refused" ? "cleanup-unconfirmed" :
      mode === "bad-frame" ? "probe-rejected" : "handoff-rejected", mode);
    assert.equal(consumed, mode === "partial" || mode === "throws", mode);
    assert.equal(probed, mode !== "missing-stop", mode);
    assert.equal((await readdir(f.stagingParent)).length, mode === "stop-refused" ? 1 : 0, mode);
  }
});

test("abort during handoff closes staged bytes without accepting late consumer completion", async t => {
  const f = await fixture(t), abort = new AbortController();
  let opened!: () => void, late!: () => void, input: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  const started = new Promise<void>(resolve => { opened = resolve; });
  const pending = new Promise<void>(resolve => { late = resolve; });
  const prepare = await createVideoDecodePreparation({ stagingParent: f.stagingParent, registry: f.registry,
    async probe(url) { await (await f.get(url, "bytes=0-15")).arrayBuffer(); return positive; },
    stopProbe: () => true,
  });
  const operation = prepare(await f.intake(), f.owner, abort.signal, {
    isCurrent: () => true,
    async consume(snapshot, signal) {
      assert.equal(signal.aborted, false);
      input = (await snapshot.open()).getReader();
      assert.equal((await input.read()).done, false);
      opened();
      return pending;
    },
  });
  await started;
  abort.abort();
  assert.deepEqual(await operation, { status: "cancelled", cleanup: "removed", inputCloseConfirmed: true });
  late();
  await assert.rejects(input!.read());
  assert.deepEqual(await readdir(f.stagingParent), []);
});
