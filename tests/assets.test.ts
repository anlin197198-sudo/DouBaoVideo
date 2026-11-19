import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createApplicationServices } from "../src/main/application/services";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { addAsset, mergeAssets } from "../src/shared/assets";
import { editScript } from "../src/shared/storyboard";
import type { TaskWorkspace } from "../src/shared/models";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=", "base64");
function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} },
    version: "test", dataDirectory: "test" });
  const tasks = database.transaction(() => services.repository.createPlan({
    title: "资产验证", style: "realistic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00",
  })).tasks;
  return { database, ...services, tasks };
}
async function save(f: ReturnType<typeof fixture>, workspace: TaskWorkspace, taskIndex = 0, expectedRevision?: number) {
  const task = f.repository.getTask(f.tasks[taskIndex]!.id);
  return f.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: {
    id: task.id, expectedRevision: expectedRevision ?? task.revision, workspace,
  } }, { trusted: true });
}

test("creates three asset types, persists edits and content versions, and keeps layout changes out of content versions", async () => {
  const f = fixture();
  try {
    let workspace = f.tasks[0]!.workspace;
    for (const type of ["person", "scene", "prop"] as const) workspace = addAsset(workspace, randomUUID(), type);
    workspace.assets[0] = { ...workspace.assets[0]!, name: "主角", description: "米色风衣" };
    assert.equal((await save(f, workspace)).ok, true);
    let restored = f.repository.getTask(f.tasks[0]!.id);
    assert.deepEqual(restored.workspace.assets.map(asset => asset.type), ["person", "scene", "prop"]);
    assert.equal(restored.workspace.assets[0]!.version, 1);
    workspace = structuredClone(restored.workspace);
    workspace.assets[0]!.position = { x: 500, y: 300 };
    assert.equal((await save(f, workspace)).ok, true);
    assert.equal(f.repository.getTask(restored.id).workspace.assets[0]!.version, 1);
    workspace.assets[0]!.description = "米色风衣，长发";
    assert.equal((await save(f, workspace)).ok, true);
    restored = f.repository.getTask(restored.id);
    assert.equal(restored.workspace.assets[0]!.version, 2);
    const reviewed = editScript(restored.workspace, "新剧本");
    assert.ok(reviewed.assets.every(asset => asset.needsReview));
    assert.equal((await save(f, reviewed)).ok, true);
    assert.equal(f.repository.getTask(restored.id).workspace.assets[0]!.version, 2);
    const stale = await save(f, workspace, 0, 0);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "CONFLICT");
    assert.equal(f.repository.getTask(f.tasks[1]!.id).workspace.assets.length, 0);
  } finally { f.database.close(); }
});

test("merges selected fields into the target identity, preserves its layout and refuses cross-type merges", () => {
  const f = fixture();
  try {
    let workspace = f.tasks[0]!.workspace;
    workspace = addAsset(addAsset(addAsset(workspace, randomUUID(), "person"), randomUUID(), "person"), randomUUID(), "prop");
    const [source, target, prop] = workspace.assets;
    source!.name = "保留的名字"; source!.description = "舍弃的设定"; source!.referenceImageId = randomUUID(); source!.needsReview = true;
    target!.description = "保留的设定";
    const choices = { name: "source", description: "target", referenceImageId: "source" } as const;
    const merged = mergeAssets(workspace, source!.id, target!.id, choices);
    assert.equal(merged.assets.length, 2);
    assert.deepEqual(merged.assets[0], { ...target!, name: source!.name, referenceImageId: source!.referenceImageId, needsReview: true });
    assert.equal(mergeAssets(workspace, source!.id, prop!.id, choices), workspace);
    assert.equal(mergeAssets(workspace, source!.id, source!.id, choices), workspace);
    assert.equal(mergeAssets(workspace, randomUUID(), target!.id, choices), workspace);
  } finally { f.database.close(); }
});

test("archives and deduplicates references, survives original deletion and restart, and scopes image references to a task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-assets-"));
  const path = join(directory, "workspace.sqlite");
  const f = fixture(path);
  let reopened: ApplicationDatabase | undefined;
  try {
    const media = join(directory, "media");
    const source = join(directory, "参考图.png");
    writeFileSync(source, png);
    const decoder = (bytes: Buffer) => ({ png: bytes, width: 1, height: 1 });
    const store = new ReferenceImageStore(f.database, media, decoder);
    const image = await store.importFile(f.tasks[0]!.id, source);
    assert.equal((await store.importFile(f.tasks[0]!.id, source)).id, image.id);
    const otherImage = await store.importFile(f.tasks[1]!.id, source);
    assert.notEqual(otherImage.id, image.id);
    assert.equal(store.pathFor("../workspace.sqlite"), null);
    let workspace = addAsset(f.tasks[0]!.workspace, randomUUID(), "person");
    workspace.assets[0]!.referenceImageId = image.id;
    assert.equal((await save(f, workspace)).ok, true);
    const wrongOwner = addAsset(f.tasks[1]!.workspace, randomUUID(), "person");
    wrongOwner.assets[0]!.referenceImageId = image.id;
    const denied = await save(f, wrongOwner, 1);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "INVALID_INPUT");
    unlinkSync(source);
    assert.deepEqual(readFileSync(store.pathFor(image.id)!), png);
    f.database.close();
    reopened = new ApplicationDatabase(path);
    const restored = new ReferenceImageStore(reopened, media, decoder);
    assert.deepEqual(readFileSync(restored.pathFor(image.id)!), png);
    unlinkSync(restored.pathFor(image.id)!);
    assert.equal(restored.pathFor(image.id), null);
    writeFileSync(source, png);
    assert.equal((await restored.importFile(f.tasks[0]!.id, source)).id, image.id);
    assert.ok(restored.pathFor(image.id));
    assert.equal(reopened.connection.prepare("SELECT COUNT(*) AS count FROM reference_images").get()?.count, 2);
  } finally {
    if (reopened) reopened.close(); else f.database.close();
    rmSync(directory, { recursive: true });
  }
});

test("rejects damaged files and rolls back orphan files when metadata cannot be committed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-assets-"));
  const f = fixture();
  try {
    const source = join(directory, "wrong.png");
    writeFileSync(source, "not a png");
    const media = join(directory, "media");
    const store = new ReferenceImageStore(f.database, media, bytes => ({ png: bytes, width: 1, height: 1 }));
    await assert.rejects(() => store.importFile(f.tasks[0]!.id, source), { code: "INVALID_INPUT" });
    writeFileSync(source, png);
    const broken = new ReferenceImageStore(f.database, media, () => { throw new Error("broken decode"); });
    await assert.rejects(() => broken.importFile(f.tasks[0]!.id, source), { code: "INVALID_INPUT" });
    const large = new ReferenceImageStore(f.database, media, bytes => ({ png: bytes, width: 9000, height: 1 }));
    await assert.rejects(() => large.importFile(f.tasks[0]!.id, source), { code: "INVALID_INPUT" });
    f.database.connection.exec("CREATE TRIGGER reject_image BEFORE INSERT ON reference_images BEGIN SELECT RAISE(ABORT, 'forced'); END;");
    await assert.rejects(() => store.importFile(f.tasks[0]!.id, source), { code: "STORAGE_ERROR" });
    assert.deepEqual(readdirSync(join(media, "references")), []);
    assert.equal(f.repository.snapshot().referenceImages.length, 0);
  } finally { f.database.close(); rmSync(directory, { recursive: true }); }
});

test("migrates version 1 database without losing plans, scripts or receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-migration-"));
  const path = join(directory, "workspace.sqlite");
  let db: ApplicationDatabase | undefined;
  try {
    const f = fixture(path); db = f.database;
    const task = f.tasks[0]!;
    const receiptId = randomUUID();
    db.connection.prepare("INSERT INTO command_receipts VALUES (?, ?, ?, ?, ?)")
      .run(receiptId, "test.migration", "test-hash", JSON.stringify({ saved: true }), new Date().toISOString());
    db.connection.prepare("UPDATE tasks SET workspace_json = ? WHERE id = ?")
      .run(JSON.stringify({ script: "旧剧本", scriptPosition: { x: 10, y: 20 }, viewport: { x: 1, y: 2, zoom: 0.8 } }), task.id);
    db.connection.exec("DROP TABLE reference_images; DROP TABLE prompt_history; ALTER TABLE plans DROP COLUMN style_notes; ALTER TABLE plans DROP COLUMN revision; ALTER TABLE tasks DROP COLUMN schedule_active; ALTER TABLE tasks DROP COLUMN execution_time; PRAGMA user_version = 1;");
    db.close(); db = undefined;
    db = new ApplicationDatabase(path);
    assert.equal(db.version, 5);
    assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count, 7);
    const row = db.connection.prepare("SELECT workspace_json FROM tasks WHERE id = ?").get(task.id);
    assert.equal(JSON.parse(String(row?.workspace_json)).script, "旧剧本");
    assert.equal(db.connection.prepare("SELECT COUNT(*) AS count FROM reference_images").get()?.count, 0);
    assert.equal(db.connection.prepare("SELECT result_json FROM command_receipts WHERE request_id = ?").get(receiptId)?.result_json,
      JSON.stringify({ saved: true }));
  } finally { db?.close(); rmSync(directory, { recursive: true }); }
});

test("rejects duplicate asset IDs, unsupported types, empty names and image references that do not exist", async () => {
  const f = fixture();
  try {
    const workspace = addAsset(f.tasks[0]!.workspace, randomUUID(), "person");
    const asset = workspace.assets[0]!;
    for (const assets of [[asset, asset], [{ ...asset, type: "invalid" }], [{ ...asset, name: " " }],
      [{ ...asset, referenceImageId: randomUUID() }], Array.from({ length: 201 }, () => ({ ...asset, id: randomUUID() }))]) {
      const response = await f.router.dispatch({ requestId: randomUUID(), command: "tasks.saveWorkspace", input: {
        id: f.tasks[0]!.id, expectedRevision: 0, workspace: { ...workspace, assets },
      } }, { trusted: true });
      assert.equal(response.ok, false);
      if (!response.ok) assert.equal(response.error.code, "INVALID_INPUT");
    }
    assert.equal(f.repository.getTask(f.tasks[0]!.id).revision, 0);
  } finally { f.database.close(); }
});
