import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { addShot, editScript, moveShot, removeShot } from "../src/shared/storyboard";

function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({
    database, logger: { command() {} }, sessions: { async open() {} },
    version: "0.1.0", dataDirectory: "test",
  });
  return { database, ...services };
}

function createPlan(f: ReturnType<typeof fixture>) {
  return f.database.transaction(() => f.repository.createPlan({
    title: "雨夜分镜", style: "realistic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00",
  }));
}

test("opens a script-only version 1 workspace without losing its content, viewport or revision", () => {
  const f = fixture();
  try {
    const task = createPlan(f).tasks[0]!;
    const legacy = { script: "已有剧本", scriptPosition: { x: 92, y: 56 }, viewport: { x: 3, y: 8, zoom: 0.7 } };
    f.database.connection.prepare("UPDATE tasks SET workspace_json = ?, revision = 4 WHERE id = ?")
      .run(JSON.stringify(legacy), task.id);
    const restored = f.repository.snapshot().tasks.find(item => item.id === task.id)!;
    assert.equal(f.database.version, 5);
    assert.equal(restored.revision, 4);
    assert.deepEqual(restored.workspace, { ...legacy, shots: [], assets: [], assetLinks: [] });
  } finally { f.database.close(); }
});

test("persists shot edits, narrative order, review flags and deletion across reopen, isolated to one task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-shots-"));
  const path = join(directory, "workspace.sqlite");
  let f = fixture(path);
  try {
    const task = createPlan(f).tasks[0]!;
    const firstId = randomUUID(), secondId = randomUUID(), deletedId = randomUUID();
    let workspace = editScript(task.workspace, "雨夜，她撑伞走进咖啡馆。");
    workspace = addShot(addShot(addShot(workspace, firstId), secondId), deletedId);
    workspace.shots[0] = { ...workspace.shots[0]!, title: "街边撑伞", description: "红伞映着窗内灯光", action: "抬头", shotSize: "中景", cameraMovement: "推进", audio: "雨声", position: { x: 780, y: 600 } };
    workspace = removeShot(moveShot(workspace, secondId, -1), deletedId);
    workspace = editScript(workspace, workspace.script + "她收起伞。");
    assert.deepEqual(workspace.shots.map(shot => shot.id), [secondId, firstId]);
    assert.equal(workspace.shots[1]!.position.y, 600);
    assert.ok(workspace.shots.every(shot => shot.needsReview));
    const request = { requestId: randomUUID(), command: "tasks.saveWorkspace", input: { id: task.id, expectedRevision: 0, workspace } };
    const saved = await f.router.dispatch(request, { trusted: true });
    assert.equal(saved.ok, true);
    assert.deepEqual(await f.router.dispatch(request, { trusted: true }), saved);
    f.database.close();
    f = fixture(path);
    const snapshot = f.repository.snapshot();
    const restored = snapshot.tasks.find(item => item.id === task.id)!;
    assert.deepEqual(restored.workspace, workspace);
    assert.equal(restored.revision, 1);
    assert.ok(snapshot.tasks.filter(item => item.id !== task.id).every(item => item.workspace.shots.length === 0));
    const stale = await f.router.dispatch({ ...request, requestId: randomUUID() }, { trusted: true });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "CONFLICT");
  } finally {
    f.database.close();
    rmSync(directory, { recursive: true });
  }
});

test("rejects duplicate shot identities, oversized lists, invalid coordinates and missing titles without a write", async () => {
  const f = fixture();
  try {
    const task = createPlan(f).tasks[0]!;
    const workspace = addShot(editScript(task.workspace, "一段剧本"), randomUUID());
    const shot = workspace.shots[0]!;
    const invalidLists = [
      [shot, shot],
      Array.from({ length: 201 }, () => ({ ...shot, id: randomUUID() })),
      [{ ...shot, position: { x: Infinity, y: 0 } }],
      [{ ...shot, title: " " }],
    ];
    for (const shots of invalidLists) {
      const result = await f.router.dispatch({
        requestId: randomUUID(), command: "tasks.saveWorkspace",
        input: { id: task.id, expectedRevision: 0, workspace: { ...workspace, shots } },
      }, { trusted: true });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    }
    const restored = f.repository.snapshot().tasks.find(item => item.id === task.id)!;
    assert.equal(restored.revision, 0);
    assert.equal(restored.workspace.shots.length, 0);
    assert.equal(addShot(task.workspace, randomUUID()), task.workspace);
    assert.equal(moveShot(workspace, shot.id, -1), workspace);
    assert.equal(editScript(workspace, workspace.script), workspace);
  } finally { f.database.close(); }
});
