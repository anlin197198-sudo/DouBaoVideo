import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { removalProblem } from "../src/shared/plan-changes";
import { editPrompt, promptInput } from "../src/shared/prompts";
import { frameState } from "../src/shared/frames";
import type { CommandInputs } from "../src/shared/bridge";

const initial = { title: "排期测试", style: "realistic" as const, startDate: "2026-12-29", dailyCount: 2, executionTime: "09:30" };
function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "isolated" });
  const created = database.transaction(() => services.repository.createPlan(initial));
  return { database, ...services, ...created };
}
function input(f: ReturnType<typeof fixture>, changes: Partial<CommandInputs["plans.create"]> = {}) {
  return { id: f.plan.id, changes: { ...initial, ...changes } };
}
test("preview requires explicit removals, preserves content and unique slots through decrease/increase/decrease/date return", () => {
  const f = fixture();
  try {
    const task = f.tasks[0]!;
    f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: 0, workspace: { ...task.workspace, script: "不能丢失的制作内容" } }));
    const smaller = input(f, { dailyCount: 1 });
    let preview = f.repository.previewPlanEdit(smaller);
    assert.ok(removalProblem(preview, []));
    const ids = preview.days.map(day => day.editable[0]!.id);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...smaller, previewToken: preview.token, removeTaskIds: ids }));
    assert.equal(f.repository.getTask(task.id).scheduleActive, false);
    assert.equal(f.repository.getTask(task.id).workspace.script, "不能丢失的制作内容");
    preview = f.repository.previewPlanEdit(input(f));
    assert.equal(preview.days.reduce((sum, day) => sum + day.add, 0), 7);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...input(f), previewToken: preview.token, removeTaskIds: [] }));
    assert.equal(f.repository.snapshot().tasks.length, 21);
    preview = f.repository.previewPlanEdit(smaller);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...smaller, previewToken: preview.token, removeTaskIds: preview.days.map(day => day.editable.at(-1)!.id) }));
    const shifted = input(f, { startDate: "2026-12-30", dailyCount: 1 });
    preview = f.repository.previewPlanEdit(shifted);
    assert.equal(preview.outside.length, 1);
    assert.equal(preview.days.at(-1)!.add, 1);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...shifted, previewToken: preview.token, removeTaskIds: preview.outside.map(task => task.id) }));
    preview = f.repository.previewPlanEdit(smaller);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...smaller, previewToken: preview.token, removeTaskIds: preview.outside.map(task => task.id) }));
    const snapshot = f.repository.snapshot();
    assert.equal(snapshot.tasks.filter(task => task.scheduleActive).length, 7);
    assert.equal(f.repository.getTask(task.id).workspace.script, "不能丢失的制作内容");
  } finally { f.database.close(); }
});

test("preview token rejects changed tasks, enable state and executions; repeated apply request replays once", async () => {
  const f = fixture();
  try {
    const change = input(f, { dailyCount: 3, executionTime: "18:00" });
    let preview = f.repository.previewPlanEdit(change);
    f.database.transaction(() => f.repository.setPlanEnabled(f.plan.id, false));
    assert.throws(() => f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] })), /重新预览/);
    preview = f.repository.previewPlanEdit(change);
    f.database.connection.prepare("INSERT INTO executions (id,task_id,operation,status,input_json,created_at,updated_at) VALUES (?,?,'video','queued','{}','now','now')").run(randomUUID(), f.tasks[1]!.id);
    assert.throws(() => f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] })), /重新预览/);
    preview = f.repository.previewPlanEdit(change);
    const task = f.tasks[0]!;
    f.database.transaction(() => f.repository.saveWorkspace({ id: task.id, expectedRevision: task.revision, workspace: { ...task.workspace, script: "并行修改" } }));
    assert.throws(() => f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] })), /重新预览/);
    preview = f.repository.previewPlanEdit(change);
    const request = { requestId: randomUUID(), command: "plans.applyEdit", input: { ...change, previewToken: preview.token, removeTaskIds: [] } };
    const first = await f.router.dispatch(request, { trusted: true });
    assert.equal(first.ok, true); assert.deepEqual(await f.router.dispatch(request, { trusted: true }), first);
    assert.equal(f.repository.snapshot().tasks.length, 21);
    assert.equal(f.repository.getTask(task.id).title, task.title);
    assert.equal(f.repository.getTask(task.id).executionTime, "18:00");
  } finally { f.database.close(); }
});

test("completed and execution/film tasks including archived stay byte-for-byte fixed; history blocks style edits", () => {
  const f = fixture();
  try {
    const [completed, executed, archived, film] = f.tasks;
    f.database.connection.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(completed!.id);
    for (const task of [executed!, archived!, film!]) {
      const executionId = randomUUID();
      f.database.connection.prepare("INSERT INTO executions (id,task_id,operation,status,input_json,created_at,updated_at) VALUES (?,?,'video','completed','{}','old','old')").run(executionId, task.id);
      if (task.id === film!.id) f.database.connection.prepare("INSERT INTO films VALUES (?,?,?,'test-file',1,'old')").run(randomUUID(), executionId, task.id);
    }
    f.database.connection.prepare("UPDATE tasks SET schedule_active=0 WHERE id=?").run(archived!.id);
    const before = f.database.connection.prepare("SELECT * FROM tasks WHERE id IN (?,?,?,?) ORDER BY id").all(completed!.id, executed!.id, archived!.id, film!.id);
    assert.ok(f.repository.previewPlanEdit(input(f, { style: "comic" })).blockers.length);
    const change = input(f, { startDate: "2027-01-15", executionTime: "20:00" });
    const preview = f.repository.previewPlanEdit(change);
    assert.equal(preview.lockedOutside.length, 3);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: preview.outside.map(task => task.id) }));
    assert.deepEqual(f.database.connection.prepare("SELECT * FROM tasks WHERE id IN (?,?,?,?) ORDER BY id").all(completed!.id, executed!.id, archived!.id, film!.id), before);
    assert.equal(f.database.connection.prepare("SELECT input_json FROM executions LIMIT 1").get()!.input_json, "{}");
  } finally { f.database.close(); }
});

test("plan style invalidates inherited confirmation irreversibly and preserves overrides and manual prompt text", () => {
  const f = fixture();
  try {
    for (const [index, task] of f.tasks.slice(0, 2).entries()) {
      const workspace = editPrompt({ ...task.workspace, ...(index ? { promptSettings: { style: "comic" as const, notes: "独立" } } : {}) }, "realistic", "video", null, "保留手写文本");
      workspace.frames = { ...frameState(workspace), confirmation: { inputSnapshot: "historical", confirmedAt: new Date().toISOString(), invalidated: false } };
      f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(workspace), task.id);
    }
    const inherited = f.tasks[0]!, override = f.tasks[1]!;
    const change = input(f, { style: "comic" });
    let preview = f.repository.previewPlanEdit(change);
    assert.ok(preview.styleAffected.includes(inherited.id)); assert.ok(!preview.styleAffected.includes(override.id));
    f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: [] }));
    const saved = f.repository.getTask(inherited.id).workspace;
    assert.equal(saved.prompts![0]!.text, "保留手写文本");
    assert.notEqual(saved.prompts![0]!.inputSnapshot, promptInput(saved, "comic", "video", null));
    assert.equal(saved.frames!.confirmation!.invalidated, true);
    assert.equal(f.repository.getTask(override.id).workspace.frames!.confirmation!.invalidated, false);
    preview = f.repository.previewPlanEdit(input(f));
    f.database.transaction(() => f.repository.applyPlanEdit({ ...input(f), previewToken: preview.token, removeTaskIds: [] }));
    assert.equal(f.repository.getTask(inherited.id).workspace.frames!.confirmation!.invalidated, true);
  } finally { f.database.close(); }
});

test("schedule removal and task-specific time survive database restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "doubao-plan-edit-"));
  const path = join(dir, "workspace.sqlite");
  let db: ApplicationDatabase | undefined;
  try {
    const f = fixture(path); db = f.database;
    const change = input(f, { dailyCount: 1, executionTime: "21:00" });
    const preview = f.repository.previewPlanEdit(change);
    f.database.transaction(() => f.repository.applyPlanEdit({ ...change, previewToken: preview.token, removeTaskIds: preview.days.map(day => day.editable[0]!.id) }));
    db.close(); db = new ApplicationDatabase(path);
    assert.equal(db.connection.prepare("SELECT COUNT(*) AS n FROM tasks WHERE schedule_active=0").get()!.n, 7);
    assert.equal(db.connection.prepare("SELECT execution_time FROM tasks WHERE schedule_active=1 LIMIT 1").get()!.execution_time, "21:00");
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("rejects oversized/overflow date schedules and invalid removal IDs without partial writes", async () => {
  const f = fixture();
  try {
    const baseline = f.repository.snapshot();
    for (const changes of [{ ...initial, dailyCount: 101 }, { ...initial, dailyCount: 1000000000 }, { ...initial, startDate: "9999-12-31" }]) {
      for (const [command, value] of [["plans.create", changes], ["plans.previewEdit", { id: f.plan.id, changes }]] as const) {
        const result = await f.router.dispatch({ command, input: value, requestId: randomUUID() }, { trusted: true });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
      }
    }
    assert.deepEqual(f.repository.snapshot(), baseline);
    const change = input(f, { dailyCount: 1 });
    const preview = f.repository.previewPlanEdit(change);
    const good = preview.days.map(day => day.editable[0]!.id);
    for (const removeTaskIds of [[], [...good, randomUUID()], [good[0]!, ...good], good.slice(1)]) {
      const result = await f.router.dispatch({ command: "plans.applyEdit", input: { ...change, previewToken: preview.token, removeTaskIds }, requestId: randomUUID() }, { trusted: true });
      assert.equal(result.ok, false);
      assert.deepEqual(f.repository.snapshot(), baseline);
    }
  } finally { f.database.close(); }
});

test("version 2 migration backfills historical task time and preserves reference metadata and workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "doubao-v2-plan-"));
  const path = join(dir, "workspace.sqlite");
  let db: ApplicationDatabase | undefined;
  try {
    const f = fixture(path); db = f.database;
    const task = f.tasks[0]!;
    const original = JSON.stringify({ ...task.workspace, script: "迁移保留", productionPositions: { "prompt:video": { x: 22, y: 33 } } });
    db.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(original, task.id);
    const image = randomUUID();
    db.connection.prepare("INSERT INTO reference_images VALUES (?,?,?,'stored.png','hash',1,1,'old')").run(image, task.id, "source.png");
    db.connection.exec("DROP TABLE prompt_history; ALTER TABLE plans DROP COLUMN style_notes; ALTER TABLE plans DROP COLUMN revision; ALTER TABLE tasks DROP COLUMN schedule_active; ALTER TABLE tasks DROP COLUMN execution_time; PRAGMA user_version=2;");
    db.close(); db = new ApplicationDatabase(path);
    const row = db.connection.prepare("SELECT * FROM tasks WHERE id=?").get(task.id)!;
    assert.equal(db.version, 5); assert.equal(row.workspace_json, original);
    assert.equal(row.execution_time, initial.executionTime); assert.equal(row.schedule_active, 1);
    assert.equal(db.connection.prepare("SELECT id FROM reference_images").get()!.id, image);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});
