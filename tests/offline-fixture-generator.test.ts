import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import sharp from "sharp";
import { makeOfflineFixture } from "../packaging/make-offline-fixture.mjs";

test("offline fixture generates deterministic bytes in independent directories with contrasting 16:9 PNGs", async () => {
 const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "doubao-offline-fixture-test-")));
 try {
  const sentinel = join(parent, "first.png"); writeFileSync(sentinel, "do not change");
  const a = makeOfflineFixture(parent), b = makeOfflineFixture(parent);
  assert.notEqual(a.root, b.root);
  assert.deepEqual(a.files, b.files);
  assert.deepEqual(readdirSync(a.root).sort(), ["first.png", "last.png", "script.txt"]);
  assert.equal(readFileSync(sentinel, "utf8"), "do not change");
  const txt = readFileSync(join(a.root, "script.txt"), "utf8");
  assert.match(txt, /合成验收／非真实剧本/);
  assert.match(txt, /镜头一：[\s\S]*镜头二：/);
  const get = async (name: string) => {
   const path = join(a.root, name);
   const metadata = await sharp(path).metadata();
   assert.equal(metadata.format, "png");
   assert.deepEqual([metadata.width, metadata.height], [320,180]);
   return (await sharp(path).raw().toBuffer()).subarray(0, 3);
  };
  assert.deepEqual(await get("first.png"), Buffer.from([70,150,216]));
  assert.deepEqual(await get("last.png"), Buffer.from([224,115,32]));
  for (const file of a.files) {
   const actual = readFileSync(join(a.root, file.name));
   assert.equal(actual.length, file.bytes);
   assert.equal(createHash("sha256").update(actual).digest("hex"), file.sha256);
  }
  assert.notEqual(a.files[1]?.sha256, a.files[2]?.sha256);
 } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("offline fixture refuses relative, aliased and missing parent paths without changing the supplied directory", () => {
 const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "doubao-offline-fixture-refusal-")));
 try {
  for (const path of ["relative", parent + "/.", join(parent, "not-created")])
   assert.throws(() => makeOfflineFixture(path));
  assert.deepEqual(readdirSync(parent), []);
 } finally { rmSync(parent, { recursive: true, force: true }); }
});
