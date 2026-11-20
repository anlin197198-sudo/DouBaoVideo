import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, link, rename, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { preflightArchiveDirectory } from "../src/main/infrastructure/archive-directory-preflight";

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dvb-archive-check-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const denied = (code: string) => Object.assign(new Error("synthetic error"), { code });

test("checks real collision and vacant hardlink, removes only own files", async t => {
  const dir = await fixture(t);
  const existing = join(dir, "recorded-video.mp4");
  await writeFile(existing, "preserve");
  const result = await preflightArchiveDirectory(dir, () => true);
  assert.equal(result, "supported");
  assert.deepEqual(await readdir(dir), ["recorded-video.mp4"]);
  assert.equal(await readFile(existing, "utf8"), "preserve");
});

test("synthetic denial is unsupported both before and after proven EEXIST", async t => {
  for (const error of ["EPERM", "EACCES"]) for (const stage of [1,2]) {
    const dir = await fixture(t);
    let calls = 0;
    const result = await preflightArchiveDirectory(dir, () => true, { async link(a,b) {
      if (++calls === stage) throw denied(error);
      await link(a,b);
    } });
    assert.equal(result, "unsupported");
    assert.deepEqual(await readdir(dir), []);
  }
});

test("lost positive ack is not support, even though own synthetic link is cleaned", async t => {
  const dir = await fixture(t);
  const result = await preflightArchiveDirectory(dir, () => true, { async link(a,b) {
    await link(a,b);
    throw denied("EPERM");
  } });
  assert.equal(result, "failed");
  assert.deepEqual(await readdir(dir), []);
});

test("staleness during collision prevents the vacant link, without stranding own files", async t => {
  const dir = await fixture(t); let current = true, calls = 0;
  const result = await preflightArchiveDirectory(dir, () => current, { async link(a,b) {
    calls++;
    try { await link(a,b); } finally { current = false; }
  } });
  assert.equal(result, "stale"); assert.equal(calls, 1);
  assert.deepEqual(await readdir(dir), []);
});

test("cleanup denial or foreign substitution leaves uncertainty and never removes foreign bytes", async t => {
  const deniedDir = await fixture(t);
  assert.equal(await preflightArchiveDirectory(deniedDir, () => true, { async unlink() { throw denied("EACCES"); } }), "cleanup-unconfirmed");
  assert.equal((await readdir(deniedDir)).length, 2);
  const dir = await fixture(t); let replacement = "";
  const result = await preflightArchiveDirectory(dir, () => true, { async link(_a,b) {
    replacement = String(b);
    await rename(replacement, replacement + ".held");
    await writeFile(replacement, "unowned", {flag:"wx"});
    throw denied("EEXIST");
  } });
  assert.equal(result, "cleanup-unconfirmed");
  assert.equal(await readFile(replacement, "utf8"), "unowned");
  assert.equal(await readFile(replacement + ".held", "utf8"), "doubao archive check B\n");
});
