import { createApplicationPaths } from "../src/main/infrastructure/paths";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogger, sanitizeCommandLog, type CommandLog, type Logger } from "../src/main/core/logger";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { CommandRouter } from "../src/main/application/command-router";
const secret = "PRIVATE_SCRIPT_PASSWORD_C:/private/profile/session";
function fixture(logger: Logger) {
  const database = new ApplicationDatabase(":memory:");
  return { database, ...createApplicationServices({ database, logger, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" }) };
}
test("file diagnostics project a finite metadata allowlist, ignoring extra fields/toJSON and arbitrary code/command/path", () => {
  const directory = mkdtempSync(join(tmpdir(), "safe-diagnostics-"));
  try {
    const logger = new FileLogger(directory), requestId = randomUUID();
    logger.command({ requestId, command: "tasks.saveWorkspace", outcome: "error", code: "CONFLICT", durationMs: 12.6,
      script: secret, prompt: secret, password: secret, path: secret, stack: secret, at: secret, toJSON() { return { leaked: secret }; } } as CommandLog);
    logger.command({ requestId: secret, command: secret, outcome: "error", code: secret, durationMs: Infinity });
    const bytes = readdirSync(directory).map(file => readFileSync(join(directory, file), "utf8")).join("");
    assert.equal(bytes.includes(secret), false);
    const [first, second] = bytes.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(Object.keys(first).sort(), ["at", "requestId", "command", "outcome", "code", "durationMs"].sort());
    assert.equal(first.requestId, requestId); assert.equal(first.command, "tasks.saveWorkspace"); assert.equal(first.code, "CONFLICT"); assert.equal(first.durationMs, 13);
    assert.match(second.requestId, /^[0-9a-f-]{36}$/); assert.equal(second.command, "invalid"); assert.equal(second.code, "INTERNAL_ERROR"); assert.equal(second.durationMs, 0);
    assert.equal(sanitizeCommandLog({ get requestId() { throw new Error(secret); } }).command, "invalid");
    assert.equal(sanitizeCommandLog({ durationMs: -99 }).durationMs, 0);
    assert.equal(sanitizeCommandLog({ durationMs: Number.MAX_VALUE }).durationMs, 86400000);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("unwritable diagnostic directory degrades to sanitized fallback, including broken stderr, without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "logger-failure-")), file = join(root, "not-directory"); writeFileSync(file, "synthetic");
  const prior = console.error, output: unknown[][] = [];
  try {
    console.error = (...args) => { output.push(args); };
    const logger = new FileLogger(join(file, "child"));
    logger.command({ requestId: secret, command: secret, outcome: "error", code: secret, durationMs: NaN });
    assert.equal(output.length, 1); assert.equal(JSON.stringify(output).includes(secret), false);
    assert.match(String(output[0]![1]), /^[0-9a-f-]{36}$/);
    console.error = () => { throw new Error(secret); };
    assert.doesNotThrow(() => logger.command({ requestId: randomUUID(), command: "app.info", outcome: "success", durationMs: 1 }));
  } finally { console.error = prior; rmSync(root, { recursive: true, force: true }); }
});
test("throwing/rejecting logger never changes committed save, idempotent replay or original conflict", async () => {
  for (const asyncFailure of [false, true]) {
    const f = fixture({ command() { if (asyncFailure) return Promise.reject(new Error(secret)); throw new Error(secret); } });
    try {
      const { tasks } = f.database.transaction(() => f.repository.createPlan({ title: "diagnostics", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" }));
      const task = tasks[0]!, requestId = randomUUID();
      const request = { requestId, command: "tasks.saveWorkspace", input: { id: task.id, expectedRevision: 0, workspace: { ...task.workspace, script: secret } } };
      const result = await f.router.dispatch(request, { trusted: true }); assert.equal(result.ok, true); assert.equal(result.requestId, requestId);
      assert.deepEqual(await f.router.dispatch(request, { trusted: true }), result);
      assert.equal(f.repository.getTask(task.id).revision, 1); assert.equal(f.repository.getTask(task.id).workspace.script, secret);
      assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, 1);
      const stale = await f.router.dispatch({ ...request, requestId: randomUUID() }, { trusted: true });
      assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "CONFLICT");
      assert.equal(f.database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, 1);
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { f.database.close(); }
  }
});
test("real router failures retain matching request UUID/category but never log input or arbitrary thrown exception", async () => {
  const directory = mkdtempSync(join(tmpdir(), "router-logs-")), f = fixture(new FileLogger(directory));
  try {
    const router = new CommandRouter(f.database, new FileLogger(directory));
    router.register("workspace.read", () => { throw new Error(secret); });
    const requestId = randomUUID(), result = await router.dispatch({ requestId, command: "workspace.read", input: {} }, { trusted: true });
    assert.equal(result.ok, false); assert.equal(result.requestId, requestId);
    if (!result.ok) assert.equal(result.error.code, "INTERNAL_ERROR");
    const invalid = await router.dispatch({ requestId: secret, command: secret, input: { password: secret } }, { trusted: true });
    assert.equal(invalid.ok, false); assert.match(invalid.requestId, /^[0-9a-f-]{36}$/);
    const bytes = readdirSync(directory).map(file => readFileSync(join(directory, file), "utf8")).join("");
    assert.equal(bytes.includes(secret), false);
    const rows = bytes.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows[0].requestId, requestId); assert.equal(rows[0].command, "workspace.read"); assert.equal(rows[0].code, "INTERNAL_ERROR");
    assert.equal(rows[1].requestId, invalid.requestId); assert.equal(rows[1].command, "invalid");
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});


test("startup creates required data/media even when logs is occupied by a file and diagnostics cannot write", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-startup-")), prior = console.error;
  let database: ApplicationDatabase | undefined;
  try {
    writeFileSync(join(root, "logs"), "not a directory");
    const paths = createApplicationPaths(root);
    assert.equal(statSync(paths.dataDirectory).isDirectory(), true);
    assert.equal(statSync(paths.media).isDirectory(), true);
    assert.equal(statSync(paths.logs).isFile(), true);
    database = new ApplicationDatabase(paths.database);
    console.error = () => {};
    assert.doesNotThrow(() => new FileLogger(paths.logs).command({ requestId: randomUUID(), command: "app.info", outcome: "success", durationMs: 1 }));
    assert.equal(database.connection.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { database?.close(); console.error = prior; rmSync(root, { recursive: true, force: true }); }
});
