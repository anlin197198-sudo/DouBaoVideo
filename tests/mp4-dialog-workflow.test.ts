import assert from "node:assert/strict";
import { test } from "node:test";
import { createMp4DialogWorkflow } from "../src/main/application/mp4-dialog-workflow";

const binding = { taskId: "86229b08-5071-453b-9a4f-8b596fee2ce4", revision: 2 };
const select = { canceled: false, filePaths: ["/synthetic/opaque.mp4"] };
function pending<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
function fixture() {
  let window = { alive: true, epoch: 0 };
  let current = true, closes = 0, snapshots = 0, intakes = 0, inspections = 0;
  const snapshot = { dev: 1, ino: 2, size: 60, mtimeMs: 2, ctimeMs: 2 };
  const makeMedia = () => ({ close: async () => { closes++; },
    evidence: { sha256: "a".repeat(64), bytes: 60, structureChecked: true as const, decoded: false as const },
    async *stream() { yield Uint8Array.of(1); } });
  const ports: Parameters<typeof createMp4DialogWorkflow<typeof window>>[0] = {
    window: () => window, epoch: owner => owner.epoch, live: owner => owner.alive,
    current: b => current && b.taskId === binding.taskId && b.revision === binding.revision,
    async select() { return select; },
    async snapshot(path) { assert.equal(path, select.filePaths[0]); snapshots++; return snapshot; },
    async intake(path, selection) { assert.equal(path, select.filePaths[0]); assert.equal(selection, snapshot); intakes++; return makeMedia(); },
    async inspect(b, media, valid, signal) {
      inspections++; assert.deepEqual(b, binding); assert.deepEqual(Object.keys(media), ["evidence", "stream"]);
      assert.equal(valid(), true); assert.equal(signal.aborted, false); assert.equal(media.evidence.decoded, false);
    },
  };
  return { ports, reload: () => { window.epoch++; }, replace: () => { window = { alive: true, epoch: 0 }; },
    closeWindow: () => { window.alive = false; }, changeTask: () => { current = false; }, makeMedia,
    counts: () => [snapshots, intakes, inspections, closes] };
}
test("MP4 dialog strict bindings and single-file cancellation cannot open media", async () => {
  const f = fixture(), run = createMp4DialogWorkflow(f.ports);
  assert.equal(await run({ ...binding, filePath: select.filePaths[0] }), "invalid-request");
  assert.equal(await run({ ...binding, revision: -1 }), "invalid-request");
  assert.equal(await run({ ...binding, revision: binding.revision + 1 }), "stale");
  for (const [selection, expected] of [
    [{ canceled: true, filePaths: select.filePaths }, "cancelled"],
    [{ canceled: false, filePaths: [] }, "cancelled"],
    [{ canceled: false, filePaths: [...select.filePaths, ...select.filePaths] }, "failed"],
    [{ canceled: false, filePaths: ["/synthetic/not-a-video.txt"] }, "failed"],
  ] as const) {
    f.ports.select = async () => ({ ...selection, filePaths: [...selection.filePaths] });
    assert.equal(await run(binding), expected);
  }
  assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});
test("late MP4 dialog results after reload, close, owner replacement or task switch never touch paths", async () => {
  for (const invalidate of ["reload", "replace", "closeWindow", "changeTask"] as const) {
    const f = fixture(), p = pending<typeof select>();
    f.ports.select = () => p.promise;
    const run = createMp4DialogWorkflow(f.ports), active = run(binding);
    assert.equal(await run(binding), "in-flight");
    f[invalidate]();
    p.settle(select);
    assert.equal(await active, "stale", invalidate);
    assert.deepEqual(f.counts(), [0, 0, 0, 0], invalidate);
  }
});
test("MP4 workflow passes only scoped inspection, cleans up on failure and fences late intake", async () => {
  const f = fixture(), run = createMp4DialogWorkflow(f.ports);
  assert.equal(await run(binding), "inspected");
  assert.deepEqual(f.counts(), [1, 1, 1, 1]);
  f.ports.inspect = async () => { throw new Error("private path must not escape"); };
  assert.equal(await run(binding), "failed");
  assert.deepEqual(f.counts(), [2, 2, 1, 2]);
  const waiting = pending<ReturnType<typeof f.makeMedia>>(), entered = pending<AbortSignal>();
  f.ports.intake = (_, __, signal) => { entered.settle(signal); return waiting.promise; };
  const context = new AbortController();
  const active = run(binding, context.signal);
  const signal = await entered.promise;
  context.abort();
  assert.equal(signal.aborted, true);
  waiting.settle(f.makeMedia());
  assert.equal(await active, "stale");
  assert.deepEqual(f.counts(), [3, 2, 1, 3]);
});

test("MP4 workflow reports stale if task or document changes before cleanup finishes", async () => {
  const f = fixture(), entered = pending<void>(), release = pending<void>();
  f.ports.intake = async () => ({ ...f.makeMedia(), close() { entered.settle(); return release.promise; } });
  const run = createMp4DialogWorkflow(f.ports), active = run(binding);
  await entered.promise;
  f.reload();
  release.settle();
  assert.equal(await active, "stale");
});
