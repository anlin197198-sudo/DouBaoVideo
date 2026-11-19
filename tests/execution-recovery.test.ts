import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { createApplicationServices } from "../src/main/application/services";
import type { WorkspaceSnapshot } from "../src/shared/models";

// tsconfig.node does not compile JSX; the test runner transpiles the renderer module
// on demand, while the production renderer build typechecks that module normally.
async function queuePage(): Promise<ComponentType<{ snapshot: Pick<WorkspaceSnapshot, "executions" | "tasks" | "accounts"> }>> {
  const rendererModule = "../src/renderer/src/pages/ExecutionRecoveryPage.tsx";
  return (await import(rendererModule)).ExecutionRecoveryPage;
}

test("execution recovery reopens real SQLite read-only and never returns raw remote identity, payload or unknown status", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dv-f16-offline-"));
  const path = join(directory, "workspace.sqlite");
  const created = "2026-11-19T01:02:03.004Z", updated = "2026-11-19T02:02:03.004Z";
  let db = new ApplicationDatabase(path);
  try {
    const repo = new WorkspaceRepository(db);
    const { tasks } = db.transaction(() => repo.createPlan({ title: "合成制作", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" }));
    const account = db.transaction(() => repo.createAccount("合成账号"));
    const insert = db.connection.prepare("INSERT INTO executions(id, task_id, account_id, operation, status, input_json, remote_reference, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
    const id = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    insert.run(id[0]!, tasks[0]!.id, account.id, "video", "generating", '{"synthetic":"NEVER_SHOW_PAYLOAD"}', "https://invalid.example/NEVER_SHOW_REFERENCE", created, updated);
    insert.run(id[1]!, tasks[1]!.id, account.id, "video", "submitting", "{}", "\t \n", created, "NEVER_SHOW_TIMESTAMP");
    insert.run(id[2]!, tasks[2]!.id, null, "NEVER_SHOW_OPERATION", "NEVER_SHOW_UNKNOWN_STATUS", "{}", null, "NEVER_SHOW_CREATED", updated);
    insert.run(id[3]!, tasks[3]!.id, null, "video", "generating", "{}", null, created, updated);
    db.close();
    db = new ApplicationDatabase(path);

    let sessionOperations = 0;
    const { router } = createApplicationServices({ database: db, logger: { command() {} }, version: "test", dataDirectory: directory,
      sessions: { async open() { sessionOperations++; } } });
    const before = db.connection.prepare("SELECT * FROM executions ORDER BY id").all();
    const result = await router.dispatch({ command: "workspace.read", input: {}, requestId: randomUUID() }, { trusted: true });
    assert.ok(result.ok);
    const snapshot = result.data as ReturnType<WorkspaceRepository["snapshot"]>;
    const recovered = new Map(snapshot.executions.map(row => [row.id, row]));
    assert.deepEqual(recovered.get(id[0]!), { id: id[0]!, taskId: tasks[0]!.id, status: "generating", accountId: account.id,
      createdAt: created, updatedAt: updated, hasRecordedRemoteReference: true });
    assert.equal(recovered.get(id[1]!)?.hasRecordedRemoteReference, false);
    assert.equal(recovered.get(id[1]!)?.updatedAt, null);
    assert.equal(recovered.get(id[2]!)?.status, "unknown");
    assert.equal(recovered.get(id[2]!)?.createdAt, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /NEVER_SHOW_/);
    assert.deepEqual(db.connection.prepare("SELECT * FROM executions ORDER BY id").all(), before);
    assert.equal(db.connection.prepare("SELECT count(*) AS n FROM command_receipts").get()?.n, 0);
    assert.equal(sessionOperations, 0);
    const ui = renderToStaticMarkup(createElement(await queuePage(), { snapshot }));
    assert.match(ui, /合成制作/); assert.match(ui, /合成账号/); assert.match(ui, /未记录账号/);
    assert.match(ui, /本地留有定位信息，未核实远端进度/);
    assert.match(ui, /待核实原请求/); assert.match(ui, /本地没有可见定位记录，不代表未提交/);
    assert.match(ui, /状态无法识别/); assert.doesNotMatch(ui, /NEVER_SHOW_|<button|<a\s/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("empty queue copy and remaining local states never claim remote completion or offer retries", async () => {
  const ExecutionRecoveryPage = await queuePage();
  const empty = renderToStaticMarkup(createElement(ExecutionRecoveryPage, { snapshot: { executions: [], tasks: [], accounts: [] } }));
  assert.match(empty, /暂无本地执行记录/); assert.match(empty, /真实生成提交、账号派发和每日调度尚未接入/);
  const executions = (["queued", "failed", "completed", "uncertain"] as const).map(status => ({
    id: status, taskId: "missing-task", accountId: "missing-account", status, createdAt: null,
    updatedAt: null, hasRecordedRemoteReference: false,
  }));
  const legacy = renderToStaticMarkup(createElement(ExecutionRecoveryPage, { snapshot: { executions, tasks: [], accounts: [] } }));
  assert.match(legacy, /仅保存为排队，不能据此判断是否已发送/);
  assert.match(legacy, /本地记录为失败/); assert.match(legacy, /本地记录为完成/);
  assert.match(legacy, /不核验远端结果或成片文件/); assert.match(legacy, /须先用原账号核实同一次请求/);
  assert.match(legacy, /原任务不可用/); assert.match(legacy, /原账号不可用/);
  assert.doesNotMatch(legacy, /missing-|<button|<a\s/);
});
