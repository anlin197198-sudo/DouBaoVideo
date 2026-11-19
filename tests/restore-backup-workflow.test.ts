import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { RestoreBackupWorkflow } from "../src/main/application/restore-backup-workflow";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import type { BackupValidationResult, IsolatedRestoreResult } from "../src/shared/models";

const validation: BackupValidationResult & { manifestSha256: string } = { manifestSha256: "a".repeat(64), directory: "/synthetic/source", createdAt: "2026-11-19T00:00:00Z", databaseVersion: 5, imageCount: 2, taskCount: 7, filmRecordCount: 0, totalBytes: 512 };
const result: IsolatedRestoreResult = { ...validation, directory: "/synthetic/new-child", isolated: true, workspaceActivated: false, videoFilesIncluded: false, notice: "not activated" };
function fixture() {
  const calls: string[] = [];
  const dependencies = {
    chooseSource: async (): Promise<string | null> => { calls.push("source"); return "/synthetic/source"; },
    validate: async (source: string) => { assert.equal(source, "/synthetic/source"); calls.push("validate"); return validation; },
    chooseDestination: async (): Promise<string | null> => { calls.push("destination"); return "/synthetic/parent"; },
    confirm: async (input: { source: string; destinationParent: string; validation: BackupValidationResult }) => {
      assert.deepEqual(input, { source: "/synthetic/source", destinationParent: "/synthetic/parent", validation }); calls.push("confirm"); return true;
    },
    restore: async (source: string, parent: string, digest: string) => { assert.equal(digest, validation.manifestSha256); assert.equal(source, "/synthetic/source"); assert.equal(parent, "/synthetic/parent"); calls.push("restore"); return result; },
  };
  return { calls, dependencies, workflow: new RestoreBackupWorkflow(dependencies) };
}

test("restore workflow validates before destination, confirms exact selections then calls revalidating service", async () => {
  const f = fixture(); assert.deepEqual(await f.workflow.run(), result);
  assert.deepEqual(f.calls, ["source", "validate", "destination", "confirm", "restore"]);
  await f.workflow.run(); assert.equal(f.calls.filter(value => value === "restore").length, 2);
});

test("source, destination and confirmation cancellation return null without any restore call", async () => {
  for (const phase of ["source", "destination", "confirm"]) {
    const f = fixture();
    if (phase === "source") f.dependencies.chooseSource = async () => null;
    if (phase === "destination") f.dependencies.chooseDestination = async () => null;
    if (phase === "confirm") f.dependencies.confirm = async () => false;
    assert.equal(await f.workflow.run(), null); assert.ok(!f.calls.includes("restore"));
    if (phase === "source") assert.deepEqual(f.calls, []);
    if (phase === "destination") assert.deepEqual(f.calls, ["source", "validate"]);
  }
});

test("validation error never opens destination; every failed phase releases lock for retry", async () => {
  for (const key of ["chooseSource", "validate", "chooseDestination", "confirm", "restore"] as const) {
    const f = fixture(), original = f.dependencies[key];
    Object.assign(f.dependencies, { [key]: async () => { throw new Error("synthetic failure"); } });
    await assert.rejects(f.workflow.run(), /synthetic failure/);
    if (key === "validate") assert.ok(!f.calls.includes("destination"));
    Object.assign(f.dependencies, { [key]: original });
    assert.deepEqual(await f.workflow.run(), result);
  }
});

test("workflow rejects overlapping requests through native source, confirmation and copy waits", async () => {
  for (const key of ["chooseSource", "confirm", "restore"] as const) {
    const f = fixture(), original = f.dependencies[key];
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
    Object.assign(f.dependencies, { [key]: async (...args: never[]) => { reached(); await gate; return (original as (...args: never[]) => Promise<unknown>)(...args); } });
    const running = f.workflow.run(); await entered;
    await assert.rejects(f.workflow.run(), /正在进行/); release(); assert.deepEqual(await running, result);
  }
});

test("restore IPC only accepts strict empty payload from trusted sender and does not record an async transaction receipt", async () => {
  const database = new ApplicationDatabase(":memory:"); let calls = 0;
  try {
    const { router } = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic", backupRestore: { async run() { calls++; return result; } } });
    const request = (input: unknown, trusted = true) => router.dispatch({ command: "workspace.restoreBackup", input, requestId: randomUUID() }, { trusted });
    assert.equal((await request({ source: "/renderer-chosen-path" })).ok, false);
    assert.equal((await request({ activate: true })).ok, false);
    assert.equal((await request({}, false)).ok, false); assert.equal(calls, 0);
    const response = await request({}); assert.equal(response.ok, true); assert.equal(calls, 1);
    assert.equal(database.connection.prepare("SELECT COUNT(*) n FROM command_receipts").get()!.n, 0);
    const unavailable = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" }).router;
    assert.equal((await unavailable.dispatch({ command: "workspace.restoreBackup", input: {}, requestId: randomUUID() }, { trusted: true })).ok, false);
  } finally { database.close(); }
});
