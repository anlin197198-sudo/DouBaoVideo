import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { arrangeCanvas, canvasBoxes, boxesOverlap, placeAddedNodes, preserveProductionPositions, resolvedProductionPositions } from "../src/shared/canvas-layout";
import { addShot, moveShot } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { editPrompt } from "../src/shared/prompts";
import { frameState, confirmationInput } from "../src/shared/frames";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import type { TaskWorkspace } from "../src/shared/models";

const empty = (): TaskWorkspace => ({ script: "剧本".repeat(500), scriptPosition: { x: 80, y: 80 }, viewport: { x: 2, y: 3, zoom: .7 }, shots: [], assets: [], assetLinks: [] });
function fixture(shots: number, assets: number) {
  let workspace = empty();
  for (let i = 0; i < shots; i++) workspace = addShot(workspace, randomUUID());
  for (let i = 0; i < assets; i++) workspace = addAsset(workspace, randomUUID(), "person");
  workspace.shots = workspace.shots.map(shot => ({ ...shot, title: "长标题".repeat(40), description: "画面\n".repeat(500), shotSize: "超长景别".repeat(30), position: { x: 80, y: 80 } }));
  workspace.assets = workspace.assets.map(asset => ({ ...asset, name: "nospaces".repeat(15), description: "描述".repeat(100), position: { x: 80, y: 80 } }));
  return editPrompt(workspace, "comic", "video", null, "手动提示词".repeat(300));
}
function content(workspace: TaskWorkspace) {
  const { productionPositions, scriptPosition, ...rest } = workspace;
  return { ...rest, shots: rest.shots.map(({ position, ...shot }) => shot), assets: rest.assets.map(({ position, ...asset }) => asset) };
}
function noOverlap(workspace: TaskWorkspace, measured?: Map<string, { width: number; height: number }>) {
  const boxes = canvasBoxes(workspace, measured);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(boxesOverlap(boxes[i]!, boxes[j]!), false, `${boxes[i]!.id} overlaps ${boxes[j]!.id}`);
}

test("arranges zero, one and many mixed nodes without overlap, preserving content, narrative order and idempotence", () => {
  for (const [shots, assets] of [[0, 0], [1, 1], [12, 9], [200, 200]]) {
    const workspace = fixture(shots!, assets!);
    workspace.frames = { ...frameState(workspace), confirmation: { inputSnapshot: confirmationInput(workspace, "comic"), confirmedAt: new Date().toISOString(), invalidated: false } };
    const arranged = arrangeCanvas(workspace);
    noOverlap(arranged); assert.deepEqual(content(arranged), content(workspace));
    assert.deepEqual(arrangeCanvas(arranged), arranged);
    for (let i = 1; i < arranged.shots.length; i++) assert.ok(arranged.shots[i]!.position.y > arranged.shots[i - 1]!.position.y);
    assert.equal(confirmationInput(arranged, "comic"), confirmationInput(workspace, "comic"));
  }
});

test("measured large dimensions adjust row and column gaps; unmeasured or invalid sizes use conservative bounds", () => {
  const workspace = fixture(4, 4);
  const measured = new Map(canvasBoxes(workspace).map((box, index) => [box.id, { width: 400 + index * 10, height: 550 + index * 30 }]));
  const arranged = arrangeCanvas(workspace, measured); noOverlap(arranged, measured);
  assert.deepEqual(arrangeCanvas(arranged, measured), arranged);
  const invalid = new Map([["script", { width: Infinity, height: NaN }], [workspace.shots[0]!.id, { width: -1, height: 0 }]]);
  noOverlap(arrangeCanvas(workspace, invalid));
});

test("new shot, prompt and asset find free space without moving existing manual coordinates", () => {
  let previous = arrangeCanvas(fixture(3, 3));
  previous.shots[0]!.position = { x: 1180, y: 80 }; // deliberately user moved into a new prompt's column
  const before = canvasBoxes(previous);
  const next = placeAddedNodes(previous, addShot(previous, randomUUID()));
  const after = canvasBoxes(next);
  for (const box of before) assert.deepEqual(after.find(item => item.id === box.id)!.position, box.position);
  for (const added of after.filter(box => !before.some(old => old.id === box.id))) for (const old of after.filter(box => box.id !== added.id)) assert.equal(boxesOverlap(added, old), false);
  const withAsset = placeAddedNodes(next, addAsset(next, randomUUID(), "scene"));
  for (const old of after) assert.deepEqual(canvasBoxes(withAsset).find(box => box.id === old.id)!.position, old.position);
});

test("legacy defaults materialize before reordering; extreme historical coordinates cannot loop or emit infinities", () => {
  const workspace = fixture(2, 2);
  const defaults = resolvedProductionPositions(workspace);
  const moved = preserveProductionPositions(workspace, moveShot(workspace, workspace.shots[0]!.id, 1));
  assert.deepEqual(moved.productionPositions, defaults);
  workspace.scriptPosition = { x: 1e308, y: 1e308 };
  workspace.assets[0]!.position = { x: -1e308, y: -1e308 };
  const next = placeAddedNodes(workspace, addShot(workspace, randomUUID()));
  assert.ok(Object.values(next.productionPositions!).every(position => Number.isFinite(position.x) && Number.isFinite(position.y)));
  assert.deepEqual(next.scriptPosition, workspace.scriptPosition);
});

test("arranged positions and untouched prompt versions persist across database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-smart-layout-"));
  const path = join(directory, "workspace.sqlite");
  let database = new ApplicationDatabase(path);
  try {
    let repository = new WorkspaceRepository(database);
    const task = database.transaction(() => repository.createPlan({ title: "布局", style: "comic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" })).tasks[0]!;
    const workspace = fixture(3, 4);
    const original = database.transaction(() => repository.saveWorkspace({ id: task.id, expectedRevision: 0, workspace }));
    const arranged = arrangeCanvas(original.workspace);
    const saved = database.transaction(() => repository.saveWorkspace({ id: task.id, expectedRevision: original.revision, workspace: arranged }));
    assert.deepEqual(saved.workspace.prompts, original.workspace.prompts);
    database.close(); database = new ApplicationDatabase(path); repository = new WorkspaceRepository(database);
    assert.deepEqual(repository.getTask(task.id).workspace, saved.workspace);
    noOverlap(repository.getTask(task.id).workspace);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
