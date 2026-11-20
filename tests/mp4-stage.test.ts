import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { createMp4Stage } from "../src/main/infrastructure/mp4-stage";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";

function box(type: string, payload: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}
const bytes = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", Buffer.from("synthetic")),
  box("mdat", Buffer.alloc(133_000, 37))]);
const evidence = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  structureChecked: true as const, decoded: false as const };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "doubao-stage-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "synthetic.mp4"), parent = join(root, "stage");
  await mkdir(parent);
  await writeFile(path, bytes);
  return { root, path, parent, stage: await createMp4Stage(parent) };
}

test("MP4 stage streams real intake, pins synced snapshot and only removes the owned file", async t => {
  const f = await fixture(t), sentinel = join(f.parent, ".doubao-mp4-stage-orphan.mp4");
  await writeFile(sentinel, "do not touch");
  const source = await intakeMp4(f.path, await lstat(f.path));
  const result = await f.stage(source);
  assert.equal(result.status, "staged");
  if (result.status !== "staged") return;
  assert.deepEqual(await readFile(result.snapshot.path), bytes);
  assert.deepEqual(await readFile(f.path), bytes);
  assert.deepEqual(result.snapshot.fingerprint, { bytes: evidence.bytes, sha256: evidence.sha256 });
  const { dev, ino, size, mtimeMs, ctimeMs } = await lstat(result.snapshot.path);
  assert.deepEqual(result.snapshot.identity, { dev, ino, size, mtimeMs, ctimeMs });
  assert.equal(await result.discard(), "removed");
  assert.equal(await result.discard(), "removed");
  assert.deepEqual(await readdir(f.parent), [".doubao-mp4-stage-orphan.mp4"]);
  await source.close();
});

test("MP4 stage with missing/mismatched bytes, changed source or cancellation exposes no snapshot", async t => {
  const f = await fixture(t);
  for (const chunk of [Buffer.alloc(1), Buffer.alloc(bytes.length, 12), Buffer.alloc(bytes.length + 1)]) {
    assert.deepEqual(await f.stage({ evidence, async *stream() { yield chunk; } }), { status: "failed", cleanup: "removed" });
    assert.deepEqual(await readdir(f.parent), []);
  }
  const abort = new AbortController();
  const abortResult = await f.stage({ evidence, async *stream() { yield bytes.subarray(0, 65536); abort.abort(); } }, abort.signal);
  assert.deepEqual(abortResult, { status: "cancelled", cleanup: "removed" });
  assert.deepEqual(await f.stage({ evidence, async *stream() { assert.fail("pre-abort must not read"); } }, abort.signal),
    { status: "cancelled", cleanup: "not-created" });
  const source = await intakeMp4(f.path, await lstat(f.path));
  const changed = await f.stage({ evidence: source.evidence, async *stream() {
    for await (const chunk of source.stream()) {
      yield chunk;
      await truncate(f.path, 10);
    }
  } });
  assert.deepEqual(changed, { status: "failed", cleanup: "removed" });
  assert.deepEqual(await readdir(f.parent), []);
  assert.equal((await lstat(f.path)).size, 10);
  await source.close();
});

test("MP4 stage leaves replacement files/roots and rejects noncanonical destinations", async t => {
  const f = await fixture(t), good = { evidence, async *stream() { yield bytes; } };
  await assert.rejects(createMp4Stage("relative"));
  await assert.rejects(createMp4Stage(f.parent + "/."));
  const result = await f.stage(good);
  if (result.status !== "staged") return assert.fail();
  const moved = join(f.root, "moved");
  await rename(result.snapshot.path, moved);
  await writeFile(result.snapshot.path, "foreign");
  assert.equal(await result.discard(), "retained-or-unknown");
  assert.equal(await readFile(result.snapshot.path, "utf8"), "foreign");
  assert.deepEqual(await readFile(moved), bytes);
  const replacement = join(f.root, "prior-parent");
  await rename(f.parent, replacement);
  await mkdir(f.parent);
  assert.deepEqual(await f.stage(good), { status: "failed", cleanup: "not-created" });
  assert.deepEqual(await readdir(f.parent), []);
});

test("real MP4 snapshot serves only the exact pinned probe ranges through the registry", async t => {
  const f = await fixture(t), input = await intakeMp4(f.path, await lstat(f.path));
  const staged = await f.stage(input);
  await input.close();
  if (staged.status !== "staged") return assert.fail();
  const owner = { ownerId: 42, documentId: randomUUID() };
  const registry = new VideoProbeRegistry({ isLive: (id, doc) => id === owner.ownerId && doc === owner.documentId });
  const { snapshot } = staged;
  const token = registry.issue({ ...owner, fingerprint: snapshot.fingerprint }, snapshot.acquire);
  assert.ok(!JSON.stringify(token).includes(snapshot.path));
  const response = await registry.response({ url: token.url, method: "GET",
    headers: new Headers({ Range: "bytes=17-131090" }) }, owner);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 17-131090/${bytes.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(17, 131091));
  const head = await registry.response({ url: token.url, method: "HEAD", headers: new Headers() }, owner);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(head.body, null);
  const next = await registry.response({ url: token.url, method: "GET", headers: new Headers() }, owner);
  assert.equal(next.status, 200);
  await next.body?.cancel();
  assert.equal(await staged.discard(), "removed");
  assert.equal((await registry.response({ url: token.url, method: "GET", headers: new Headers() }, owner)).status, 404);
  assert.deepEqual(await readdir(f.parent), []);
});

test("staged probe fails closed on tampering after acquisition and preserves changed bytes", async t => {
  const f = await fixture(t);
  const staged = await f.stage({ evidence, async *stream() { yield bytes; } });
  if (staged.status !== "staged") return assert.fail();
  const owner = { ownerId: 42, documentId: randomUUID() };
  const registry = new VideoProbeRegistry({ isLive: () => true });
  const token = registry.issue({ ...owner, fingerprint: staged.snapshot.fingerprint }, staged.snapshot.acquire);
  const request = { url: token.url, method: "GET", headers: new Headers() };
  const response = await registry.response(request, owner);
  assert.equal(response.status, 200);
  const changed = Buffer.alloc(bytes.length, 9);
  await writeFile(staged.snapshot.path, changed);
  await assert.rejects(response.arrayBuffer());
  assert.equal((await registry.response(request, owner)).status, 404);
  assert.equal(await staged.discard(), "retained-or-unknown");
  assert.deepEqual(await readFile(staged.snapshot.path), changed);
});

test("real staged probe acquisition cannot survive discard or an expired registry token", async t => {
  const f = await fixture(t);
  const good = { evidence, async *stream() { yield bytes; } };
  for (const mode of ["discard-during-acquisition", "expire-after-acquisition", "discard-after-transfer"] as const) {
    const staged = await f.stage(good);
    if (staged.status !== "staged") return assert.fail();
    const owner = { ownerId: 42, documentId: randomUUID() };
    let now = 0;
    const registry = new VideoProbeRegistry({ isLive: () => true, now: () => now, ttlMs: 10 });
    const token = registry.issue({ ...owner, fingerprint: staged.snapshot.fingerprint }, async () => {
      const acquired = await staged.snapshot.acquire();
      if (mode === "expire-after-acquisition") now = 10;
      return acquired;
    });
    const pending = registry.response({ url: token.url, method: "GET", headers: new Headers() }, owner);
    if (mode === "discard-during-acquisition") assert.equal(await staged.discard(), "removed");
    const response = await pending;
    if (mode === "discard-after-transfer") {
      assert.equal(response.status, 200);
      assert.equal(await staged.discard(), "removed");
      await assert.rejects(response.arrayBuffer());
    } else assert.equal(response.status, 404);
    assert.equal(await staged.discard(), "removed");
    assert.deepEqual(await readdir(f.parent), []);
  }
});

test("staged probe bounds concurrent file handles and allows fresh acquisition after close", async t => {
  const f = await fixture(t), staged = await f.stage({ evidence, async *stream() { yield bytes; } });
  if (staged.status !== "staged") return assert.fail();
  const acquire = staged.snapshot.acquire;
  const eight = await Promise.all(Array.from({ length: 8 }, () => acquire()));
  await assert.rejects(acquire());
  await eight[0]?.source.close();
  const returned = await acquire();
  assert.equal(returned.source.byteLength, bytes.length);
  assert.equal(await staged.discard(), "removed");
  await assert.rejects(acquire());
});
