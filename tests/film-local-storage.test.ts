import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registeredVideoResponse } from "../src/main/application/registered-video-response";
import { createRegisteredVideoLookup, type RegisteredVideoEntry } from "../src/main/infrastructure/registered-video-source";
import { writeVerifiedVideoBytes } from "../src/main/infrastructure/video-byte-writer";

test("synthetic archive keeps two same-title task versions separately and serves only the registered bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dvb-storage-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const work = { taskId: randomUUID(), title: "同名任务" };
  async function publish(version: number, bytes: Uint8Array) {
    const identity = { ...work, version, executionId: randomUUID() };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const input = { directory, identity, expectedBytes: bytes.length, expectedSha256: sha256 };
    const chunks = async function* () { yield bytes.subarray(0, 7); yield bytes.subarray(7); };
    const saved = await writeVerifiedVideoBytes({ ...input, chunks: chunks() });
    assert.equal(saved.status, "published");
    assert.equal(saved.cleanup, "removed");
    const stats = await lstat(saved.target);
    const entry: RegisteredVideoEntry = { id: randomUUID(), identity, bytes: bytes.length, sha256, dev: stats.dev, ino: stats.ino };
    return { saved, entry, input };
  }
  const original = Uint8Array.from({ length: 90 }, (_, i) => i);
  const newVersion = Uint8Array.from({ length: 90 }, (_, i) => 200 - i);
  const old = await publish(1, original);
  const next = await publish(2, newVersion);
  assert.notEqual(old.saved.target, next.saved.target);
  const overwrite = await writeVerifiedVideoBytes({
    ...old.input, expectedSha256: next.entry.sha256,
    chunks: (async function* () { yield newVersion; })(),
  });
  assert.equal(overwrite.status, "not-published");
  assert.equal(overwrite.automaticRetry, false);
  const lookUpOld = await createRegisteredVideoLookup(directory, [old.entry]);
  const request = (id: string) => new Request(`app://video/${id}`, { headers: { Range: "bytes=31-37" } });
  const part = await registeredVideoResponse(request(old.entry.id), lookUpOld);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 31-37/90");
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), original.subarray(31, 38));
  assert.equal((await registeredVideoResponse(request(next.entry.id), lookUpOld)).status, 404);
  assert.deepEqual(new Uint8Array(await readFile(old.saved.target)), original);
  assert.deepEqual(new Uint8Array(await readFile(next.saved.target)), newVersion);
});
