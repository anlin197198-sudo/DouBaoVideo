import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { productionNodes, productionEdges, storeProductionPositions, nextLocalStep } from "../src/shared/canvas-production";
import { addShot, moveShot, removeShot } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { editPrompt } from "../src/shared/prompts";
import { addFrameCandidate, chooseFrame, confirmationInput, hasCurrentConfirmation } from "../src/shared/frames";
import { connectionError } from "../src/shared/asset-links";
import { commandSchemas } from "../src/shared/validation";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import type { TaskWorkspace } from "../src/shared/models";

const empty = (): TaskWorkspace => ({ script: "", shots: [], assets: [], assetLinks: [], scriptPosition: { x: 80, y: 80 }, viewport: { x: 0, y: 0, zoom: 1 } });

test("legacy canvas derives stable prompt/frame nodes without rewriting content; source edges cannot become asset references", () => {
  const workspace = addShot(addShot({ ...empty(), script: "故事" }, randomUUID()), randomUUID());
  const before = JSON.stringify(workspace);
  const nodes = productionNodes(workspace, "realistic");
  assert.equal(nodes.prompts.length, 5); assert.equal(nodes.frames.length, 2);
  assert.equal(JSON.stringify(workspace), before);
  assert.equal(nodes.prompts[0]!.selection, `shot:${workspace.shots[0]!.id}`);
  assert.equal(nodes.frames[1]!.slot, "last");
  const ids = new Set(["script", ...workspace.shots.map(shot => shot.id), ...nodes.prompts.map(node => node.id), ...nodes.frames.map(node => node.id)]);
  for (const edge of productionEdges(workspace)) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.ok(connectionError(workspace, edge.source, edge.target));
  }
});

test("drag coordinates survive schema/save/reopen with viewport and old workspace compatibility", () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-canvas-layout-"));
  let db = new ApplicationDatabase(join(directory, "workspace.sqlite"));
  try {
    let repo = new WorkspaceRepository(db);
    const { tasks } = db.transaction(() => repo.createPlan({ title: "布局", style: "comic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" }));
    const task = tasks[0]!;
    assert.equal(task.workspace.productionPositions, undefined);
    let workspace = addShot({ ...task.workspace, script: "剧本" }, randomUUID());
    workspace = { ...workspace, viewport: { x: -15, y: 60, zoom: 0.5 }, productionPositions: storeProductionPositions(workspace,
      new Map([["prompt:video", { x: 42, y: 87 }], ["frame:last", { x: 800, y: 300 }]])) };
    const input = commandSchemas["tasks.saveWorkspace"].parse({ id: task.id, expectedRevision: 0, workspace });
    db.transaction(() => repo.saveWorkspace(input)); db.close();
    db = new ApplicationDatabase(join(directory, "workspace.sqlite")); repo = new WorkspaceRepository(db);
    const restored = repo.getTask(task.id).workspace;
    assert.deepEqual(restored.productionPositions, workspace.productionPositions);
    assert.deepEqual(restored.viewport, workspace.viewport);
    assert.deepEqual(productionNodes(restored, "comic").frames[1]!.position, { x: 800, y: 300 });
    assert.throws(() => commandSchemas["tasks.saveWorkspace"].parse({ ...input, workspace: { ...workspace, productionPositions: { invalid: { x: 1, y: 2 } } } }));
    assert.throws(() => commandSchemas["tasks.saveWorkspace"].parse({ ...input, workspace: { ...workspace, productionPositions: { "frame:first": { x: NaN, y: 2 } } } }));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("deleting and reordering shots cleans layout/source references without losing unrelated coordinates or prompt text", () => {
  let workspace = addShot(addShot({ ...empty(), script: "故事" }, randomUUID()), randomUUID());
  const [first, last] = workspace.shots;
  workspace = editPrompt(workspace, "realistic", "shot", last!.id, "保留文字");
  workspace.productionPositions = { [`prompt:shot:${first!.id}`]: { x: 12, y: 13 }, [`prompt:shot:${last!.id}`]: { x: 14, y: 15 }, "frame:first": { x: 16, y: 17 } };
  const moved = moveShot(workspace, last!.id, -1);
  assert.deepEqual(moved.productionPositions, workspace.productionPositions);
  assert.equal(productionNodes(moved, "realistic").prompts[0]!.shotId, last!.id);
  const removed = removeShot(moved, first!.id);
  assert.equal(removed.productionPositions![`prompt:shot:${first!.id}`], undefined);
  assert.equal(removed.prompts![0]!.text, "保留文字");
  assert.ok(!productionEdges(removed).some(edge => edge.source.includes(first!.id) || edge.target.includes(first!.id)));
  assert.deepEqual(storeProductionPositions(removed, new Map()), removed.productionPositions);
});

test("local steps support manual import without optional prompts and layout changes preserve confirmation", () => {
  let workspace = empty();
  const importedWorkflow = editPrompt(empty(), "realistic", "video", null, "本地导图的视频描述");
  assert.equal(nextLocalStep(importedWorkflow, "realistic").target, "frame:first");
  assert.equal(nextLocalStep(workspace, "realistic").target, "script");
  workspace = { ...workspace, script: "故事" };
  assert.equal(nextLocalStep(workspace, "realistic").target, "add-shot");
  workspace = addShot(workspace, randomUUID());
  assert.equal(nextLocalStep(workspace, "realistic").target, "assets");
  workspace = addAsset(workspace, randomUUID(), "person");
  assert.equal(nextLocalStep(workspace, "realistic").target, "prompt:video");
  workspace = editPrompt(workspace, "realistic", "video", null, "视频正文");
  assert.equal(nextLocalStep(workspace, "realistic").target, "frame:first");
  for (const slot of ["first", "last"] as const) {
    const id = randomUUID(); workspace = chooseFrame(addFrameCandidate(workspace, "realistic", slot, randomUUID(), id, new Date().toISOString()), slot, id);
  }
  assert.equal(nextLocalStep(workspace, "realistic").label, "审核两张图片");
  workspace.frames!.confirmation = { inputSnapshot: confirmationInput(workspace, "realistic"), confirmedAt: new Date().toISOString(), invalidated: false };
  workspace = { ...workspace, productionPositions: { "prompt:video": { x: 200, y: 300 }, "frame:first": { x: 400, y: 500 } } };
  assert.equal(hasCurrentConfirmation(workspace, "realistic"), true);
  assert.equal(nextLocalStep(workspace, "realistic").label, "本地图片已确认，真实生成待接入");
});
