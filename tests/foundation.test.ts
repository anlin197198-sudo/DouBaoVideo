import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createApplicationServices } from "../src/main/application/services";
import { CommandRouter } from "../src/main/application/command-router";
import type { CommandLog } from "../src/main/core/logger";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { DoubaoProvider } from "../src/main/providers/doubao-provider";

const planInput = {
  title: "雨夜的七个片刻",
  style: "realistic" as const,
  startDate: "2026-12-29",
  dailyCount: 2,
  executionTime: "09:30",
};

function fixture(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  const logs: CommandLog[] = [];
  const opened: string[] = [];
  const logger = {
    command: (entry: CommandLog) => {
      logs.push(entry);
    },
  };
  const services = createApplicationServices({
    database,
    logger,
    sessions: {
      open: async (account) => {
        opened.push(account.id);
      },
    },
    version: "0.1.0",
    dataDirectory: "test-data",
  });
  return { database, logs, opened, logger, ...services };
}

test("creates seven calendar days across a year boundary and replays one mutation only once", async () => {
  const f = fixture();
  try {
    const request = {
      requestId: randomUUID(),
      command: "plans.create",
      input: planInput,
    };
    const first = await f.router.dispatch(request, { trusted: true });
    const replay = await f.router.dispatch(request, { trusted: true });
    assert.equal(first.ok, true);
    assert.deepEqual(replay, first);
    const snapshot = f.repository.snapshot();
    assert.equal(snapshot.plans.length, 1);
    assert.equal(snapshot.tasks.length, 14);
    assert.equal(snapshot.tasks[0]?.businessDate, "2026-12-29");
    assert.equal(snapshot.tasks.at(-1)?.businessDate, "2027-01-04");
  } finally {
    f.database.close();
  }
});

test("rejects a reused mutation identifier when its payload changes", async () => {
  const f = fixture();
  try {
    const requestId = randomUUID();
    await f.router.dispatch(
      { requestId, command: "plans.create", input: planInput },
      { trusted: true },
    );
    const result = await f.router.dispatch(
      {
        requestId,
        command: "plans.create",
        input: { ...planInput, title: "其他计划" },
      },
      { trusted: true },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CONFLICT");
    assert.equal(f.repository.snapshot().plans.length, 1);
  } finally {
    f.database.close();
  }
});

test("checks sender and request schema before any persistent mutation", async () => {
  const f = fixture();
  try {
    const denied = await f.router.dispatch(
      { requestId: randomUUID(), command: "plans.create", input: planInput },
      { trusted: false },
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "UNAUTHORIZED");
    for (const input of [
      { ...planInput, startDate: "2026-02-30" },
      { ...planInput, dailyCount: 0 },
      { ...planInput, executionTime: "25:00" },
      { ...planInput, unexpected: "value" },
    ]) {
      const result = await f.router.dispatch(
        { requestId: randomUUID(), command: "plans.create", input },
        { trusted: true },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    }
    const unknown = await f.router.dispatch(
      { requestId: randomUUID(), command: "filesystem.read", input: {} },
      { trusted: true },
    );
    assert.equal(unknown.ok, false);
    assert.equal(f.repository.snapshot().plans.length, 0);
    assert.equal(f.repository.snapshot().tasks.length, 0);
  } finally {
    f.database.close();
  }
});

test("rolls back partial work and its receipt together", async () => {
  const f = fixture();
  try {
    const router = new CommandRouter(f.database, f.logger);
    router.register(
      "accounts.create",
      (input) => {
        f.repository.createAccount(input.nickname);
        throw new Error("Simulated failure after a partial write");
      },
      { transactional: true },
    );
    const result = await router.dispatch(
      {
        requestId: randomUUID(),
        command: "accounts.create",
        input: { nickname: "账号" },
      },
      { trusted: true },
    );
    assert.equal(result.ok, false);
    assert.equal(f.repository.snapshot().accounts.length, 0);
    assert.equal(
      f.database.connection
        .prepare("SELECT COUNT(*) AS count FROM command_receipts")
        .get()?.count,
      0,
    );
  } finally {
    f.database.close();
  }
});

test("uses revisions to preserve the more recent workspace when a stale editor saves", async () => {
  const f = fixture();
  try {
    await f.router.dispatch(
      { requestId: randomUUID(), command: "plans.create", input: planInput },
      { trusted: true },
    );
    const task = f.repository.snapshot().tasks[0]!;
    const input = {
      id: task.id,
      expectedRevision: task.revision,
      workspace: { ...task.workspace, script: "已经保存的新剧本" },
    };
    const current = await f.router.dispatch(
      { requestId: randomUUID(), command: "tasks.saveWorkspace", input },
      { trusted: true },
    );
    assert.equal(current.ok, true);
    const stale = await f.router.dispatch(
      {
        requestId: randomUUID(),
        command: "tasks.saveWorkspace",
        input: {
          ...input,
          workspace: { ...input.workspace, script: "旧编辑内容" },
        },
      },
      { trusted: true },
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "CONFLICT");
    const saved = f.repository
      .snapshot()
      .tasks.find((item) => item.id === task.id)!;
    assert.equal(saved.workspace.script, "已经保存的新剧本");
    assert.equal(saved.revision, 1);
  } finally {
    f.database.close();
  }
});

test("persists migrated records and idempotency receipts after closing the database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doubao-foundation-"));
  const path = join(directory, "workspace.sqlite");
  let db: ApplicationDatabase | undefined;
  try {
    const f = fixture(path);
    db = f.database;
    await f.router.dispatch(
      { requestId: randomUUID(), command: "plans.create", input: planInput },
      { trusted: true },
    );
    db.close();
    db = undefined;
    db = new ApplicationDatabase(path);
    assert.equal(db.version, 1);
    assert.equal(new WorkspaceRepository(db).snapshot().tasks.length, 14);
    assert.equal(
      db.connection
        .prepare("SELECT COUNT(*) AS count FROM command_receipts")
        .get()?.count,
      1,
    );
  } finally {
    db?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true });
  }
});

test("keeps unknown account capabilities after opening a login window and omits user content from logs", async () => {
  const f = fixture();
  try {
    const secretText = "用户自定义账号昵称";
    await f.router.dispatch(
      {
        requestId: randomUUID(),
        command: "accounts.create",
        input: { nickname: secretText },
      },
      { trusted: true },
    );
    const account = f.repository.snapshot().accounts[0]!;
    await f.router.dispatch(
      {
        requestId: randomUUID(),
        command: "accounts.openLogin",
        input: { id: account.id },
      },
      { trusted: true },
    );
    assert.deepEqual(f.opened, [account.id]);
    assert.equal(f.repository.getAccount(account.id).loginState, "unknown");
    assert.equal(
      f.repository.getAccount(account.id).videoCapability,
      "unknown",
    );
    assert.equal(JSON.stringify(f.logs).includes(secretText), false);
  } finally {
    f.database.close();
  }
});

test("exposes provider verification state and rejects unverified generation", () => {
  const provider = new DoubaoProvider();
  assert.equal(provider.readiness().state, "unverified");
  assert.throws(() => provider.requireVerifiedEntry(), {
    code: "PROVIDER_UNAVAILABLE",
  });
});
