import { removeV7Schema } from "./removal-schema-fixture";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, renameSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceBackup, hashBackupFile } from "../src/main/infrastructure/workspace-backup";
import { RestoreBackupWorkflow } from "../src/main/application/restore-backup-workflow";
import { IsolatedRestore, validateRestorePreview } from "../src/main/infrastructure/isolated-restore";

const decode = async (bytes: Buffer) => { const value = await sharp(bytes).png().toBuffer({ resolveWithObject: true }); return { png: value.data, width: value.info.width, height: value.info.height }; };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "restore-test-")), live = join(root, "live"), backups = join(root, "backups"), output = join(root, "output");
  for (const path of [live, backups, output]) mkdirSync(path);
  const database = new ApplicationDatabase(join(live, "workspace.sqlite")), repository = new WorkspaceRepository(database);
  const task = database.transaction(() => repository.createPlan({ title: "restore synthetic", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" })).tasks[0]!;
  const media = join(live, "media"), input = join(root, "input.png"); mkdirSync(media);
  writeFileSync(input, await sharp({ create: { width: 8, height: 6, channels: 3, background: "#234567" } }).png().toBuffer());
  const image = await new ReferenceImageStore(database, media, decode).importFile(task.id, input);
  mkdirSync(join(live, "Partitions")); writeFileSync(join(live, "Partitions", "secret-cookie"), "do not copy");
  const backup = await new WorkspaceBackup({ database, mediaDirectory: media, applicationVersion: "test", chooseDirectory: async () => backups, decode }).create();
  const source = backup!.directory;
  function hashes() { return JSON.stringify(["manifest.json", "workspace.sqlite", `media/references/${image.id}.png`].map(path => [path, createHash("sha256").update(readFileSync(join(source, path))).digest("hex")])); }
  return { root, live, output, source, image, task, hashes, close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("isolated restore creates distinct exclusive copies, preserves original bytes and can reopen independently", async () => {
  const f = await fixture();
  try {
    const original = f.hashes();
    const service = new IsolatedRestore({ currentWorkspace: f.live, decode });
    const a = await service.restore(f.source, f.output), b = await service.restore(f.source, f.output);
    assert.notEqual(a.directory, b.directory); assert.equal(a.workspaceActivated, false); assert.equal(a.videoFilesIncluded, false);
    assert.deepEqual(readdirSync(a.directory).sort(), ["manifest.json", "media", "workspace.sqlite"]);
    assert.equal(f.hashes(), original); assert.equal(existsSync(join(a.directory, "Partitions")), false);
    const db = new ApplicationDatabase(join(a.directory, "workspace.sqlite"));
    try { assert.equal(new WorkspaceRepository(db).getTask(f.task.id).title, f.task.title); assert.ok(new ReferenceImageStore(db, join(a.directory, "media"), decode).isAvailable(f.image.id)); }
    finally { db.close(); }
    assert.equal(f.hashes(), original);
  } finally { f.close(); }
});

test("rejects protected parents and links without any new output; sibling parent is allowed", async () => {
  const f = await fixture();
  try {
    const service = new IsolatedRestore({ currentWorkspace: f.live, decode });
    for (const parent of [f.live, join(f.live, "media"), f.source, join(f.source, "media")]) await assert.rejects(service.restore(f.source, parent));
    const link = join(f.root, "linked-output"); symlinkSync(f.output, link, "dir");
    await assert.rejects(service.restore(f.source, link));
    const sourceLink = join(f.root, "linked-source"); symlinkSync(f.source, sourceLink, "dir");
    await assert.rejects(service.restore(sourceLink, f.output));
    assert.deepEqual(readdirSync(f.output), []);
    const result = await service.restore(f.source, f.root); assert.ok(result.directory.startsWith(f.root));
  } finally { f.close(); }
});

test("cancel before start or during output verification removes only this attempt, overlap rejected", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new IsolatedRestore({ currentWorkspace: f.live, decode }).restore(f.source, f.output, controller.signal));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(done => { release = done; }), reached = new Promise<void>(done => { entered = done; });
    const abort = new AbortController(); let calls = 0;
    const service = new IsolatedRestore({ currentWorkspace: f.live, decode: async bytes => { if (++calls === 2) { entered(); await gate; } return decode(bytes); } });
    const running = service.restore(f.source, f.output, abort.signal);
    await reached;
    await assert.rejects(service.restore(f.source, f.output), /正在进行/);
    abort.abort(); release(); await assert.rejects(running, /取消/);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

test("source changes after initial validation and output corruption fail with no success-looking directory", async () => {
  for (const mode of ["source", "output"] as const) {
    const f = await fixture();
    try {
      let calls = 0;
      const service = new IsolatedRestore({ currentWorkspace: f.live, decode: async bytes => {
        if (++calls === 2) {
          if (mode === "source") writeFileSync(join(f.source, "unexpected.txt"), "changed source");
          else {
            const output = join(f.output, readdirSync(f.output)[0]!);
            writeFileSync(join(output, "media", "references", `${f.image.id}.png`), "corrupt");
          }
        }
        return decode(bytes);
      } });
      await assert.rejects(service.restore(f.source, f.output));
      assert.deepEqual(readdirSync(f.output), []);
      assert.equal(readFileSync(join(f.live, "Partitions", "secret-cookie"), "utf8"), "do not copy");
    } finally { f.close(); }
  }
});

test("traversal and extra session files are rejected before creating a destination", async () => {
  const f = await fixture();
  try {
    const path = join(f.source, "manifest.json"), original = readFileSync(path);
    const manifest = JSON.parse(original.toString()); manifest.files[0].path = "../live/Partitions/secret-cookie";
    writeFileSync(path, JSON.stringify(manifest));
    await assert.rejects(new IsolatedRestore({ currentWorkspace: f.live, decode }).restore(f.source, f.output));
    writeFileSync(path, original); mkdirSync(join(f.source, "Partitions"));
    await assert.rejects(new IsolatedRestore({ currentWorkspace: f.live, decode }).restore(f.source, f.output));
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

test("captured malicious manifest is rejected itself, before any validator callback can substitute a valid ABA manifest", async () => {
  const f = await fixture();
  try {
    const path = join(f.source, "manifest.json"), valid = readFileSync(path);
    const malicious = JSON.parse(valid.toString()); malicious.files[0].path = "../../escaped.sqlite";
    writeFileSync(path, JSON.stringify(malicious));
    let calls = 0;
    const service = new IsolatedRestore({ currentWorkspace: f.live, decode: async bytes => {
      calls++; writeFileSync(path, valid); return decode(bytes);
    } });
    await assert.rejects(service.restore(f.source, f.output));
    assert.equal(calls, 0); // Reject A before invoking independently-reading validation B.
    assert.equal(existsSync(join(f.root, "escaped.sqlite")), false);
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

test("output is verified again after the final source verification, catching late destination corruption", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const service = new IsolatedRestore({ currentWorkspace: f.live, decode: async bytes => {
      if (++calls === 3) {
        const output = join(f.output, readdirSync(f.output)[0]!);
        writeFileSync(join(output, "media", "references", `${f.image.id}.png`), "corrupted during source recheck");
      }
      return decode(bytes);
    } });
    await assert.rejects(service.restore(f.source, f.output));
    assert.equal(calls, 3); assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

test("detectable parent replacement is rejected before writes; replaced output is never cleaned or modified", async () => {
  for (const phase of [1, 2]) {
    const f = await fixture();
    try {
      let calls = 0, replacement = "";
      const service = new IsolatedRestore({ currentWorkspace: f.live, decode: async bytes => {
        if (++calls === phase) {
          replacement = phase === 1 ? f.output : join(f.output, readdirSync(f.output)[0]!);
          renameSync(replacement, replacement + "-moved"); mkdirSync(replacement);
          writeFileSync(join(replacement, "keep.txt"), "unrelated replacement");
        }
        return decode(bytes);
      } });
      await assert.rejects(service.restore(f.source, f.output));
      assert.deepEqual(readdirSync(replacement), ["keep.txt"]);
      assert.equal(readFileSync(join(replacement, "keep.txt"), "utf8"), "unrelated replacement");
    } finally { f.close(); }
  }
});

test("V3, V4, V5 and V6 copies remain in original format and source schema and files never migrate", async () => {
  for (const version of [3, 4, 5, 6]) {
    const f = await fixture();
    try {
      const path = join(f.source, "workspace.sqlite"), db = new DatabaseSync(path);
      try { db.exec(removeV7Schema + (version < 6 ? "DROP TABLE script_history; " : "") + (version < 5 ? "DROP TABLE prompt_history; " : "") + (version === 3 ? "ALTER TABLE plans DROP COLUMN style_notes; " : "") + "PRAGMA user_version=" + version); }
      finally { db.close(); }
      const manifestPath = join(f.source, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      Object.assign(manifest.files.find((file: { path: string }) => file.path === "workspace.sqlite"), await hashBackupFile(path));
      manifest.databaseVersion = version; writeFileSync(manifestPath, JSON.stringify(manifest));
      const original = f.hashes();
      const result = await new IsolatedRestore({ currentWorkspace: f.live, decode }).restore(f.source, f.output);
      assert.equal(result.databaseVersion, version); assert.equal(f.hashes(), original);
      assert.deepEqual(await hashBackupFile(join(result.directory, "workspace.sqlite")), await hashBackupFile(path));
      const copied = new DatabaseSync(join(result.directory, "workspace.sqlite"), { readOnly: true });
      try { assert.equal(copied.prepare("PRAGMA user_version").get()!.user_version, version); }
      finally { copied.close(); }
    } finally { f.close(); }
  }
});


test("confirmation is bound to backup A and rejects replacement by another fully valid backup B", async () => {
  const a = await fixture(), b = await fixture();
  try {
    const restore = new IsolatedRestore({ currentWorkspace: a.live, decode });
    let confirmations = 0;
    const workflow = new RestoreBackupWorkflow({
      chooseSource: async () => a.source,
      validate: source => validateRestorePreview(source, decode),
      chooseDestination: async () => a.output,
      confirm: async () => {
        confirmations++;
        if (confirmations === 1) { rmSync(a.source, { recursive: true }); cpSync(b.source, a.source, { recursive: true }); }
        return true;
      },
      restore: (source, parent, digest) => restore.restore(source, parent, undefined, digest),
    });
    await assert.rejects(workflow.run(), /已确认预览不同/);
    assert.deepEqual(readdirSync(a.output), []);
    // A fresh preview and a second explicit confirmation may approve B.
    const second = await workflow.run(); assert.ok(second); assert.equal(confirmations, 2);
    assert.equal(second.workspaceActivated, false);
  } finally { a.close(); b.close(); }
});

test("preview detects a valid manifest change while validating and never returns mismatched approval metadata", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    await assert.rejects(validateRestorePreview(f.source, async bytes => {
      if (++calls === 1) {
        const path = join(f.source, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.applicationVersion = "changed-during-preview"; writeFileSync(path, JSON.stringify(manifest));
      }
      return decode(bytes);
    }));
    assert.deepEqual(readdirSync(f.output), []);
  } finally { f.close(); }
});

test("late final-verification cancel/failure preserves an existing V7 restore and live bytes, then permits retry", async () => {
  for (const mode of ["cancel", "failure"] as const) {
    const f = await fixture();
    try {
      const previous = await new IsolatedRestore({ currentWorkspace: f.live, decode }).restore(f.source, f.output);
      assert.equal(previous.databaseVersion, 7);
      const snapshot = (directory: string) => JSON.stringify(["manifest.json", "workspace.sqlite", `media/references/${f.image.id}.png`]
        .map(path => [path, createHash("sha256").update(readFileSync(join(directory, path))).digest("hex")]));
      const originalSource = f.hashes(), originalPrevious = snapshot(previous.directory);
      const originalLive = readFileSync(join(f.live, "workspace.sqlite"));
      const originalLiveImage = readFileSync(join(f.live, "media", "references", `${f.image.id}.png`));
      const originalChildren = readdirSync(f.output);
      const abort = new AbortController(); let calls = 0;
      const service = new IsolatedRestore({ currentWorkspace: f.live, decode: async bytes => {
        if (++calls === 4) { // initial source, output, source recheck, FINAL output verification
          assert.equal(readdirSync(f.output).length, 2);
          if (mode === "cancel") abort.abort();
          else throw new Error("synthetic final verification failure");
        }
        return decode(bytes);
      } });
      await assert.rejects(service.restore(f.source, f.output, abort.signal));
      assert.equal(calls, 4);
      assert.deepEqual(readdirSync(f.output), originalChildren);
      assert.equal(snapshot(previous.directory), originalPrevious); assert.equal(f.hashes(), originalSource);
      assert.deepEqual(readFileSync(join(f.live, "workspace.sqlite")), originalLive);
      assert.deepEqual(readFileSync(join(f.live, "media", "references", `${f.image.id}.png`)), originalLiveImage);
      // Same service instance has released its running lock; retry must create another exclusive child.
      const retried = await service.restore(f.source, f.output);
      assert.notEqual(retried.directory, previous.directory); assert.equal(retried.workspaceActivated, false);
      assert.equal(readdirSync(f.output).length, 2); assert.equal(snapshot(previous.directory), originalPrevious);
      assert.equal(f.hashes(), originalSource); assert.equal(retried.databaseVersion, 7);
    } finally { f.close(); }
  }
});
