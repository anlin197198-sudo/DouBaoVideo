import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { addShot, editScript } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { editPrompt, reviewPrompt } from "../src/shared/prompts";
import { addFrameCandidate, chooseFrame, hasCurrentConfirmation } from "../src/shared/frames";

test("complete local chain survives closed database, source relocation, reconfirmation and second restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-local-chain-"));
  const path = join(directory, "workspace.sqlite");
  let db = new ApplicationDatabase(path);
  const open = () => ({ repo: new WorkspaceRepository(db), store: new ReferenceImageStore(db, join(directory, "media"), async bytes => {
    const result = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
    return { png: result.data, width: result.info.width, height: result.info.height };
  }) });
  try {
    let { repo, store } = open();
    const { tasks } = db.transaction(() => repo.createPlan({ title: "完整本地制作验收", style: "realistic", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" }));
    const taskId = tasks[0]!.id;
    let w = editScript(tasks[0]!.workspace, "主角从竹林取剑，走向山门。");
    w = addShot(addShot(w, randomUUID()), randomUUID());
    for (const type of ["person", "scene", "prop"] as const) w = addAsset(w, randomUUID(), type);
    for (const asset of w.assets) for (const shot of w.shots) w = setAssetLink(w, asset.id, shot.id, true);
    w = { ...w, viewport: { x: -123, y: 45, zoom: 0.75 }, promptSettings: { style: "comic", notes: "水墨色彩" } };
    for (const shot of w.shots) w = editPrompt(w, "realistic", "shot", shot.id, `镜头：${shot.title}`);
    for (const kind of ["firstFrame", "lastFrame", "video"] as const) w = editPrompt(w, "realistic", kind, null, `${kind} 人工编辑内容`);
    let task = db.transaction(() => repo.saveWorkspace({ id: taskId, expectedRevision: tasks[0]!.revision, workspace: w }));
    w = task.workspace;
    const sources: string[] = [];
    for (const [slot, color] of [["first", "#245f34"], ["last", "#e4b545"]] as const) {
      const file = join(directory, `${slot}.png`); sources.push(file);
      writeFileSync(file, await sharp({ create: { width: 120, height: 80, channels: 3, background: color } }).png().toBuffer());
      const image = await store.importFile(taskId, file);
      const id = randomUUID();
      w = chooseFrame(addFrameCandidate(w, "realistic", slot, image.id, id, new Date().toISOString()), slot, id);
    }
    task = db.transaction(() => repo.saveWorkspace({ id: taskId, expectedRevision: task.revision, workspace: w }));
    task = db.transaction(() => repo.confirmFrames({ id: taskId, expectedRevision: task.revision }, id => store.isAvailable(id)));
    const expected = structuredClone(task);
    db.close();
    for (const file of sources) renameSync(file, `${file}.moved`);
    db = new ApplicationDatabase(path); ({ repo, store } = open());
    task = repo.getTask(taskId);
    assert.deepEqual(task, expected);
    assert.equal(task.workspace.shots.length, 2);
    assert.equal(task.workspace.assets.length, 3);
    assert.equal(task.workspace.assetLinks.length, 6);
    assert.equal(task.workspace.prompts!.length, 5);
    assert.equal(hasCurrentConfirmation(task.workspace, "realistic"), true);
    assert.ok(task.workspace.frames!.candidates.every(candidate => store.isAvailable(candidate.imageId)));
    assert.equal(repo.getTask(tasks[1]!.id).workspace.script, "");
    w = editScript(task.workspace, "主角从竹林取剑，停在山门前。");
    task = db.transaction(() => repo.saveWorkspace({ id: taskId, expectedRevision: task.revision, workspace: w }));
    assert.equal(hasCurrentConfirmation(task.workspace, "realistic"), false);
    assert.throws(() => repo.confirmFrames({ id: taskId, expectedRevision: task.revision }, id => store.isAvailable(id)));
    w = task.workspace;
    for (const prompt of w.prompts!) w = reviewPrompt(w, "realistic", prompt.kind, prompt.shotId);
    task = db.transaction(() => repo.saveWorkspace({ id: taskId, expectedRevision: task.revision, workspace: w }));
    task = db.transaction(() => repo.confirmFrames({ id: taskId, expectedRevision: task.revision }, id => store.isAvailable(id)));
    const reconfirmed = structuredClone(task);
    db.close(); db = new ApplicationDatabase(path); ({ repo, store } = open());
    assert.deepEqual(repo.getTask(taskId), reconfirmed);
    assert.equal(hasCurrentConfirmation(repo.getTask(taskId).workspace, "realistic"), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
