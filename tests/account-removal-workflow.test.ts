import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AccountRemovalWorkflow, type AccountRemovalStore, type RemovalSnapshot, type RemovalLease, type RemovalPreview } from "../src/main/application/account-removal-workflow";

/** Synthetic adapter only: synchronous Map CAS models transactions, not a production lease. */
function fixture() {
  const id = randomUUID(), other = randomUUID();
  const accounts = new Map<string, RemovalSnapshot>([id, other].map(accountId => [accountId, { accountId, nickname: "测试账号", revision: 0, enabled: true, state: "present", blockingExecutionIds: [] }]));
  const references = [{ taskId: "synthetic-task", accountId: id }, { filmId: "synthetic-film", accountId: id }];
  const leases = new Map<string, RemovalLease>(), operations = new Map<string, string>();
  const calls: string[] = []; let completeFails = false, cleanupFails = false, failFails = false;
  let confirm: (p: RemovalPreview) => Promise<boolean> = async () => true;
  let cleanupHook: (() => Promise<void>) | undefined;
  const store: AccountRemovalStore = {
    async read(key) { return structuredClone(accounts.get(key)!); },
    async begin(key, revision) {
      const a = accounts.get(key)!;
      if (a.state === "removed") return { status: "removed" };
      if (a.revision !== revision || leases.has(key)) return { status: "conflict" };
      if (a.blockingExecutionIds.length) return { status: "blocked", blockingExecutionIds: [...a.blockingExecutionIds] };
      a.enabled = false; a.state = "pending"; a.revision++;
      const lease = { accountId: key, operationId: operations.get(key) ?? randomUUID(), leaseToken: randomUUID() };
      operations.set(key, lease.operationId); leases.set(key, lease); calls.push("begin");
      return { status: "started", lease };
    },
    async complete(lease) {
      if (leases.get(lease.accountId)?.leaseToken !== lease.leaseToken) throw new Error("stale lease");
      calls.push("complete"); if (completeFails) throw new Error("commit failed");
      const a = accounts.get(lease.accountId)!; a.state = "removed"; a.enabled = false; a.revision++; leases.delete(lease.accountId);
    },
    async fail(lease) {
      if (failFails) throw new Error("release failed");
      if (leases.get(lease.accountId)?.leaseToken === lease.leaseToken) leases.delete(lease.accountId);
      // Do not undo a possibly committed removal.
    },
  };
  const make = () => new AccountRemovalWorkflow({ store, confirm: p => confirm(p), cleanup: async lease => {
    calls.push("cleanup"); assert.equal(accounts.get(lease.accountId)!.enabled, false);
    assert.equal(accounts.get(lease.accountId)!.state, "pending");
    await cleanupHook?.(); if (cleanupFails) throw new Error("clear failed");
    return { accountId: lease.accountId, operationId: lease.operationId, verified: true };
  } });
  return { id, other, accounts, references, calls, leases, operations, store, make,
    setConfirm(value: typeof confirm) { confirm = value; }, setCleanupHook(value: typeof cleanupHook) { cleanupHook = value; },
    errors(cleanup: boolean, complete = false, fail = false) { cleanupFails = cleanup; completeFails = complete; failFails = fail; } };
}
test("cancel and active/unknown blockers before or during confirmation never start cleanup", async () => {
  const f = fixture(), workflow = f.make(), before = structuredClone(f.accounts);
  f.setConfirm(async preview => { assert.match(preview.disclosure, /保留.*任务.*成片/); return false; });
  assert.deepEqual(await workflow.run(f.id), { status: "cancelled" }); assert.deepEqual(f.accounts, before);
  f.accounts.get(f.id)!.blockingExecutionIds = ["active", "unknown-status"];
  assert.deepEqual(await workflow.run(f.id), { status: "blocked", blockingExecutionIds: ["active", "unknown-status"] });
  f.accounts.get(f.id)!.blockingExecutionIds = [];
  f.setConfirm(async () => { f.accounts.get(f.id)!.blockingExecutionIds = ["new-unknown"]; return true; });
  assert.equal((await workflow.run(f.id)).status, "blocked"); assert.deepEqual(f.calls, []);
});
test("stale confirmation is rejected and confirmation cannot mutate the expected scope/revision", async () => {
  const f = fixture();
  f.setConfirm(async preview => { preview.account.accountId = f.other; preview.account.revision = 999; f.accounts.get(f.id)!.revision++; return true; });
  await assert.rejects(f.make().run(f.id), /变化/); assert.deepEqual(f.calls, []);
  await assert.rejects(f.make().run("../partition"), /标识/);
});
test("cleanup failure and retry preserve disabled pending identity/references and reuse idempotency operation", async () => {
  const f = fixture(), workflow = f.make(), other = structuredClone(f.accounts.get(f.other)), references = structuredClone(f.references);
  f.errors(true); const failed = await workflow.run(f.id); assert.equal(failed.status, "pending");
  assert.equal(f.accounts.get(f.id)!.enabled, false); assert.equal(f.accounts.get(f.id)!.state, "pending");
  const operation = f.operations.get(f.id); f.errors(false);
  assert.deepEqual(await workflow.run(f.id), { status: "removed" }); assert.equal(f.operations.get(f.id), operation);
  const calls = [...f.calls]; assert.deepEqual(await workflow.run(f.id), { status: "removed" }); assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.accounts.get(f.other), other); assert.deepEqual(f.references, references); assert.equal(f.accounts.size, 2);
});
test("same-account overlap and distinct workflow instances are fenced by atomic begin before cleanup", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  f.setCleanupHook(() => { entered(); return new Promise<void>(r => { release = r; }); });
  const workflow = f.make(), first = workflow.run(f.id); await started;
  await assert.rejects(workflow.run(f.id), /正在进行/);
  await assert.rejects(f.make().run(f.id), /变化/);
  assert.equal(f.calls.filter(c => c === "cleanup").length, 1);
  release(); assert.equal((await first).status, "removed");
});
test("failed completion or failed lease release cannot claim removal or reenable; scoped cleanup verification is mandatory", async () => {
  const f = fixture(); f.errors(false, true);
  const result = await f.make().run(f.id); assert.equal(result.status, "pending"); if (result.status === "pending") assert.equal(result.stage, "complete");
  assert.equal(f.accounts.get(f.id)!.state, "pending"); assert.equal(f.accounts.get(f.id)!.enabled, false);
  f.errors(false); assert.equal((await f.make().run(f.id)).status, "removed");
  const g = fixture(); g.errors(true, false, true);
  assert.equal((await g.make().run(g.id)).status, "pending"); assert.equal(g.leases.size, 1); assert.equal(g.accounts.get(g.id)!.enabled, false);
  const h = fixture();
  const wrongScope = new AccountRemovalWorkflow({ store: h.store, confirm: async () => true,
    cleanup: async lease => ({ accountId: h.other, operationId: lease.operationId, verified: true }) });
  assert.equal((await wrongScope.run(h.id)).status, "pending"); assert.equal(h.calls.includes("complete"), false);
});

test("begin failure makes no claim of disabled state; ambiguous completion never rolls back committed removal", async () => {
  const f = fixture(), begin = f.store.begin;
  f.store.begin = async () => { throw new Error("transaction unavailable"); };
  await assert.rejects(f.make().run(f.id), /transaction unavailable/);
  assert.equal(f.accounts.get(f.id)!.enabled, true); assert.deepEqual(f.calls, []);
  f.store.begin = begin;
  const complete = f.store.complete;
  f.store.complete = async lease => { await complete(lease); throw new Error("response lost after commit"); };
  assert.equal((await f.make().run(f.id)).status, "pending");
  assert.equal(f.accounts.get(f.id)!.state, "removed"); assert.equal(f.accounts.get(f.id)!.enabled, false);
  const calls = [...f.calls]; assert.equal((await f.make().run(f.id)).status, "removed"); assert.deepEqual(f.calls, calls);
});
