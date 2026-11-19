import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPackage, uncache } from "@electron/asar";
import { auditWindowsDirectory } from "../packaging/audit-windows.mjs";

function syntheticPE(dll: boolean, machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(0xf0, 84);
  bytes.writeUInt16LE(dll ? 0x2002 : 0x0002, 86);
  bytes.writeUInt16LE(0x020b, 88);
  return bytes;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dvb-package-audit-"));
  const out = join(root, "out");
  const directory = join(root, "win-unpacked");
  const archive = join(directory, "resources", "app.asar");
  const native = join(directory, "resources", "app.asar.unpacked", "node_modules", "@img", "sharp-win32-x64", "lib");
  t.after(async () => {
    uncache(archive);
    await rm(root, { recursive: true, force: true });
  });
  for (const relative of ["main/index.js", "preload/index.cjs", "renderer/index.html", "renderer/assets/index-x.js"]) {
    const output = join(out, relative);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, relative);
  }
  const source = join(root, "archive-source");
  await mkdir(source);
  await cp(out, join(source, "out"), { recursive: true });
  await mkdir(native, { recursive: true });
  await createPackage(source, archive);
  await writeFile(join(directory, "DouBaoVideo.exe"), syntheticPE(false));
  for (const name of ["sharp-win32-x64-0.35.5.node", "libvips-42.dll", "libvips-cpp-8.18.7.dll"]) {
    await writeFile(join(native, name), syntheticPE(true));
  }
  return { out, directory, native, archive };
}

test("package audit checks all current bundled bytes and x64 Windows native file headers", async (t) => {
  const { out, directory } = await fixture(t);
  assert.deepEqual(auditWindowsDirectory(directory, out), { bundles: 4, nativeLibraries: 3 });
  await writeFile(join(out, "main", "index.js"), "main/index.xx");
  assert.throws(() => auditWindowsDirectory(directory, out), /Packaged bytes differ.*main\/index\.js/);
  await writeFile(join(out, "renderer", "assets", "index-another.js"), "from another build");
  assert.throws(() => auditWindowsDirectory(directory, out), /file list does not match/);
});

test("package audit rejects unrelated executables, wrong native architecture, and ambiguous runtime", async (t) => {
  const { out, directory, native } = await fixture(t);
  const executable = join(directory, "DouBaoVideo.exe");
  await writeFile(executable, syntheticPE(true));
  assert.throws(() => auditWindowsDirectory(directory, out), /x64 Windows PE32\+ application/);
  await writeFile(executable, syntheticPE(false));
  await writeFile(join(native, "libvips-42.dll"), syntheticPE(true, 0xaa64));
  assert.throws(() => auditWindowsDirectory(directory, out), /libvips-42.dll:.*x64 Windows PE32\+ library/);
  await writeFile(join(native, "libvips-42.dll"), syntheticPE(true));
  await writeFile(join(native, "libvips-43.dll"), syntheticPE(true));
  assert.throws(() => auditWindowsDirectory(directory, out), /missing or ambiguous/);
});

test("package audit rejects truncated ASAR body and an oversized header before reading bundle bytes", async (t) => {
  const { out, directory, archive } = await fixture(t);
  await truncate(archive, (await stat(archive)).size - 1);
  assert.throws(() => auditWindowsDirectory(directory, out), /Packaged bytes differ/);
  const malformed = Buffer.alloc(8);
  malformed.writeUInt32LE(4, 0);
  malformed.writeUInt32LE(0xffffffff, 4);
  await writeFile(archive, malformed);
  assert.throws(() => auditWindowsDirectory(directory, out), /Invalid ASAR header bounds/);
});
