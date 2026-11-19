import { removeV7Schema } from "./removal-schema-fixture";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { promptInput, editPrompt, effectiveStyleNotes, updatePromptSettings } from "../src/shared/prompts";
import { addShot } from "../src/shared/storyboard";
import { addFrameCandidate, chooseFrame, hasCurrentConfirmation } from "../src/shared/frames";
import { commandSchemas } from "../src/shared/validation";

const input = { title: "说明继承", style: "comic" as const, styleNotes: "A 柔光", startDate: "2026-11-18", dailyCount: 1, executionTime: "09:00" };
function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path), repository = new WorkspaceRepository(database);
  const created = database.transaction(() => repository.createPlan(input));
  return { database, repository, ...created };
}
test("notes inheritance is independent of style and preserves legacy nonempty overrides and deliberate empty override", () => {
  const f = fixture();
  try {
    let workspace = addShot(f.tasks[0]!.workspace, randomUUID());
    // addShot requires a script; create one first.
    workspace = addShot({ ...workspace, script: "故事" }, randomUUID());
    assert.equal(effectiveStyleNotes(workspace, f.plan), input.styleNotes);
    const legacy = { ...workspace, promptSettings: { style: null, notes: "旧任务说明" } };
    assert.equal(effectiveStyleNotes(legacy, f.plan), "旧任务说明");
    const blank = { ...workspace, promptSettings: { style: "realistic" as const, notes: "", notesMode: "override" as const } };
    assert.equal(effectiveStyleNotes(blank, f.plan), "");
    const inherit = { ...blank, promptSettings: { ...blank.promptSettings, notesMode: "inherit" as const } };
    for (const kind of ["shot", "video", "firstFrame", "lastFrame"] as const) {
      const parsed = JSON.parse(promptInput(inherit, f.plan, kind, kind === "shot" ? workspace.shots[0]!.id : null));
      assert.equal(parsed.styleNotes, input.styleNotes); assert.equal(parsed.style, "偏真人");
    }
    assert.equal(commandSchemas["plans.create"].safeParse({ ...input, styleNotes: "x".repeat(5001) }).success, false);
  } finally { f.database.close(); }
});

test("plan notes preview affects inherited tasks only, preserves text and irreversibly invalidates confirmed frames A-B-A", () => {
  const f = fixture();
  try {
    const task = f.tasks[0]!, override = f.tasks[1]!;
    let workspace = editPrompt(task.workspace, f.plan, "video", null, "不可覆盖的手写提示词");
    const imageId = randomUUID();
    f.database.connection.prepare("INSERT INTO reference_images VALUES (?,?,?,?,?,1,1,'now')").run(imageId, task.id, "synthetic.png", `${imageId}.png`, "logic-fixture");
    for (const slot of ["first", "last"] as const) { const id = randomUUID(); workspace = chooseFrame(addFrameCandidate(workspace, f.plan, slot, imageId, id, new Date().toISOString()), slot, id); }
    let saved = f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: 0, workspace }));
    saved = f.database.transaction(() => f.repository.confirmFrames({ id: task.id, expectedRevision: saved.revision }, () => true));
    assert.equal(hasCurrentConfirmation(saved.workspace, f.plan), true);
    f.database.transaction(() => f.repository.saveWorkspace({ id: override.id, expectedRevision: 0, workspace: { ...override.workspace, promptSettings: { style: null, notes: "", notesMode: "override" } } }));
    const change = { id: f.plan.id, changes: { ...input, styleNotes: "B 高反差" } };
    let preview = f.repository.previewPlanEdit(change);
    assert.ok(preview.styleAffected.includes(task.id)); assert.ok(!preview.styleAffected.includes(override.id));
    f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] }));
    assert.equal(f.repository.getTask(task.id).workspace.prompts![0]!.text, "不可覆盖的手写提示词");
    assert.equal(f.repository.getTask(task.id).workspace.frames!.confirmation!.invalidated, true);
    preview = f.repository.previewPlanEdit({ id: f.plan.id, changes: input });
    f.database.transaction(() => f.repository.applyPlanEdit({ id: f.plan.id, changes: input, previewToken: preview.token, removeTaskIds: [] }));
    assert.equal(hasCurrentConfirmation(f.repository.getTask(task.id).workspace, f.plan), false);
    const localB = updatePromptSettings(saved.workspace, f.plan, { style: null, notes: "B", notesMode: "override" });
    const localA = updatePromptSettings(localB, f.plan, { style: null, notes: "A 柔光", notesMode: "override" });
    assert.equal(hasCurrentConfirmation(localA, f.plan), false);
    assert.throws(() => f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: saved.revision, workspace: saved.workspace })), /更新/);
  } finally { f.database.close(); }
});

test("inherited executed notes cannot be changed; explicit override history remains byte-identical", () => {
  const f = fixture();
  try {
    const task = f.tasks[0]!;
    f.database.connection.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(task.id);
    const change = { id: f.plan.id, changes: { ...input, styleNotes: "B" } };
    assert.ok(f.repository.previewPlanEdit(change).blockers.some(message => message.includes("继承计划说明")));
    f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify({ ...task.workspace, promptSettings: { style: null, notes: "旧", notesMode: "override" } }), task.id);
    const before = f.database.connection.prepare("SELECT * FROM tasks WHERE id=?").get(task.id);
    const preview = f.repository.previewPlanEdit(change); assert.deepEqual(preview.blockers, []);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] }));
    assert.deepEqual(f.database.connection.prepare("SELECT * FROM tasks WHERE id=?").get(task.id), before);
  } finally { f.database.close(); }
});

test("V3 migrates with empty plan notes, old task text preserved, V4 plan notes survive reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-style-migration-")), path = join(directory, "workspace.sqlite");
  let database: ApplicationDatabase | undefined;
  try {
    const f = fixture(path); database = f.database;
    const task = f.tasks[0]!;
    const workspace = { ...task.workspace, promptSettings: { style: null, notes: "保留旧说明" } };
    database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(workspace), task.id);
    database.connection.exec(removeV7Schema + "DROP TABLE script_history; DROP TABLE prompt_history; ALTER TABLE plans DROP COLUMN style_notes; PRAGMA user_version=3;");
    database.close(); database = new ApplicationDatabase(path);
    let repository = new WorkspaceRepository(database);
    assert.equal(database.version, 7); assert.equal(repository.snapshot().plans[0]!.styleNotes, "");
    assert.deepEqual(repository.getTask(task.id).workspace, workspace);
    const change = { id: f.plan.id, changes: input };
    const preview = repository.previewPlanEdit(change);
    database.transaction(() => repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] }));
    database.close(); database = new ApplicationDatabase(path); repository = new WorkspaceRepository(database);
    assert.equal(repository.snapshot().plans[0]!.styleNotes, input.styleNotes);
    assert.equal(effectiveStyleNotes(repository.getTask(task.id).workspace, repository.snapshot().plans[0]!), "保留旧说明");
  } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
});
