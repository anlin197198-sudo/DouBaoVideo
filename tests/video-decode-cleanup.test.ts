import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoDecodePreparation } from "../src/main/application/prepare-video-decode";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
const bytes = Buffer.from("synthetic stage bytes, not a decoded movie");
const positive = { status: "first-presented-frame", evidence: { durationSeconds: 1, videoWidth: 8,
  videoHeight: 6, mediaTime: 0.1, presentedFrames: 1, width: 8, height: 6 } };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "decode-cleanup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { ownerId: 9, documentId: randomUUID() };
  const registry = new VideoProbeRegistry({ isLive: (id, doc) => id === owner.ownerId && doc === owner.documentId });
  let closed = 0, issued = "", probeSignal: AbortSignal | undefined;
  const input = { evidence: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    structureChecked: true as const, decoded: false as const },
    async *stream() { yield bytes; }, async close() { closed++; } };
  const get = () => registry.response({ url: issued, method: "HEAD", headers: new Headers() }, owner);
  const probe = async (url: string, _owner: unknown, signal: AbortSignal) => {
    issued = url; probeSignal = signal;
    assert.equal((await get()).status, 200);
    return positive;
  };
  return { root, owner, registry, input, probe, get, get closed() { return closed; }, get signal() { return probeSignal; } };
}
test("confirmed own-probe stop follows revoke/abort and precedes stage discard", async t => {
  const f = await fixture(t); let calls = 0;
  const prepare = await createVideoDecodePreparation({ stagingParent: f.root, registry: f.registry, probe: f.probe,
    async stopProbe(owner) {
      calls++; assert.deepEqual(owner, f.owner); assert.ok(Object.isFrozen(owner));
      assert.equal(f.signal?.aborted, true); assert.equal((await f.get()).status, 404);
      const entries = await readdir(f.root); assert.equal(entries.length, 1);
      assert.deepEqual(await readFile(join(f.root, entries[0]!)), bytes);
      return true;
    } });
  assert.equal((await prepare(f.input, f.owner)).status, "first-frame-observed");
  assert.equal(calls, 1); assert.equal(f.closed, 1); assert.deepEqual(await readdir(f.root), []);
});
test("false/rejected/timed-out stop preserves stage and suppresses success, including late true", async t => {
  for (const mode of ["false", "reject", "timeout", "slow-sync"] as const) {
    const f = await fixture(t); let late!: (value: boolean) => void;
    const prepare = await createVideoDecodePreparation({ stagingParent: f.root, registry: f.registry, probe: f.probe,
      stopProbeTimeoutMs: 15,
      stopProbe: () => {
        if (mode === "slow-sync") { const end = performance.now() + 25; while (performance.now() < end) { /* Simulate a blocking trusted port. */ } return true; }
        return mode === "false" ? false : mode === "reject" ? Promise.reject(Error("private detail")) :
          new Promise<boolean>(resolve => { late = resolve; });
      } });
    assert.deepEqual(await prepare(f.input, f.owner), { status: "cleanup-unconfirmed", cleanup: "retained-or-unknown", inputCloseConfirmed: true });
    assert.equal(f.closed, 1); assert.equal((await f.get()).status, 404);
    const entries = await readdir(f.root); assert.equal(entries.length, 1);
    assert.deepEqual(await readFile(join(f.root, entries[0]!)), bytes);
    if (mode === "timeout") { late(true); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.deepEqual(await readdir(f.root), entries);
  }
});
test("cleanup timeout configuration is bounded and absent hook preserves existing behavior", async t => {
  const f = await fixture(t);
  for (const stopProbeTimeoutMs of [0, -1, 1001, 1.5, NaN, Infinity]) {
    await assert.rejects(createVideoDecodePreparation({ stagingParent: f.root, registry: f.registry, probe: f.probe, stopProbeTimeoutMs }));
  }
  const prepare = await createVideoDecodePreparation({ stagingParent: f.root, registry: f.registry, probe: f.probe });
  assert.equal((await prepare(f.input, f.owner)).status, "first-frame-observed");
  assert.equal(f.closed, 1); assert.deepEqual(await readdir(f.root), []);
});
