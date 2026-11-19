import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { RemovalLease } from "../src/main/application/account-removal-workflow";
import { AccountSessionLifecycle, type SessionWindow } from "../src/main/application/account-session-lifecycle";
import { SqliteAccountSessionFence } from "../src/main/infrastructure/account-session-fence";
import { SqliteAccountRemovalStore } from "../src/main/infrastructure/account-removal-store";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";

class FakeWindow implements SessionWindow {
  destroyed = false; shown = 0; focused = 0; destroyedCalls = 0; loadCalls = 0;
  refuseDestroy = false; throwDestroy = false; throwShow = false;
  closed: () => void = () => {};
  resolve!: () => void; reject!: (error: Error) => void;
  private readonly loaded = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyedCalls++; if (this.throwDestroy) throw new Error("native destroy failed"); if (!this.refuseDestroy) { this.destroyed = true; this.closed(); } }
  show() { this.shown++; if (this.throwShow) throw new Error("show failed"); } focus() { this.focused++; }
  onClosed(callback: () => void) { this.closed = callback; }
  load() { this.loadCalls++; return this.loaded; }
}
function fixture() {
  const database = new ApplicationDatabase(":memory:");
  const app = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" });
  const account = app.repository.createAccount("A"), other = app.repository.createAccount("B");
  const fence = new SqliteAccountSessionFence(() => database), store = new SqliteAccountRemovalStore(database);
  const windows: FakeWindow[] = [];
  const lifecycle = new AccountSessionLifecycle(fence, () => { const window = new FakeWindow(); windows.push(window); return window; });
  const begin = async () => { const result = await store.begin(account.id, (await store.read(account.id)).revision); assert.equal(result.status, "started"); if (result.status !== "started") throw new Error("lease missing"); return result.lease; };
  return { database, app, account, other, fence, store, windows, lifecycle, begin };
}

test("concurrent same-account opens share a hidden load and only show after successful fresh fence", async () => {
  const f = fixture(); try {
    const one = f.lifecycle.open(f.account), two = f.lifecycle.open(f.account);
    assert.equal(one, two); assert.equal(f.windows.length, 1); assert.equal(f.windows[0]!.loadCalls, 1); assert.equal(f.windows[0]!.shown, 0);
    f.windows[0]!.resolve(); await Promise.all([one, two]); assert.equal(f.windows[0]!.shown, 1);
    await f.lifecycle.open(f.account); assert.equal(f.windows.length, 1); assert.equal(f.windows[0]!.shown, 2);
    f.lifecycle.closeAll();
  } finally { f.database.close(); }
});

test("pending before creation and pending/removed during load prevent show and close only owned in-flight window", async () => {
  for (const complete of [false, true]) {
    const f = fixture(); try {
      const otherOpen = f.lifecycle.open(f.other); f.windows[0]!.resolve(); await otherOpen;
      const open = f.lifecycle.open(f.account), rejected = assert.rejects(open, /移除/), target = f.windows[1]!;
      const lease = await f.begin(); if (complete) await f.store.complete(lease);
      await assert.rejects(f.lifecycle.open(f.account), /移除/); assert.equal(f.windows.length, 2);
      target.resolve(); await rejected;
      assert.equal(target.shown, 0); assert.equal(target.destroyed, true); assert.equal(f.windows[0]!.destroyed, false);
      f.lifecycle.closeAll();
    } finally { f.database.close(); }
  }
});

test("explicit removal close requires current account/operation/token, verifies destroyed, and never claims persistent session cleared", async () => {
  const f = fixture(); try {
    const opening = f.lifecycle.open(f.account), rejection = assert.rejects(opening, /移除/), window = f.windows[0]!;
    const lease = await f.begin();
    for (const bad of [{ ...lease, leaseToken: randomUUID() }, { ...lease, operationId: randomUUID() }, { ...lease, accountId: f.other.id }])
      assert.throws(() => f.lifecycle.closeForRemoval(bad), /租约/);
    assert.equal(window.destroyedCalls, 0);
    window.refuseDestroy = true; assert.throws(() => f.lifecycle.closeForRemoval(lease), /验证/);
    await assert.rejects(f.lifecycle.open(f.account), /移除/); assert.equal(f.windows.length, 1);
    window.refuseDestroy = false; window.throwDestroy = true; assert.throws(() => f.lifecycle.closeForRemoval(lease), /native destroy/);
    window.throwDestroy = false;
    assert.deepEqual(f.lifecycle.closeForRemoval(lease), { accountId: f.account.id, operationId: lease.operationId, ownedWindowClosed: true, sessionCleared: false });
    assert.equal(window.destroyed, true); window.resolve(); await rejection;
    await f.store.fail(lease); const newer = await f.begin(); assert.throws(() => f.lifecycle.closeForRemoval(lease), /租约/);
    assert.equal(f.lifecycle.closeForRemoval(newer).sessionCleared, false);
  } finally { f.database.close(); }
});

test("late old closed/load-failure events cannot remove a replacement window and shutdown forbids late show or reopen", async () => {
  const f = fixture(); try {
    const first = f.lifecycle.open(f.account), firstRejected = assert.rejects(first, /old load failed/), old = f.windows[0]!;
    old.destroyed = true; // Native window is already gone, but its closed event is delayed.
    const second = f.lifecycle.open(f.account), current = f.windows[1]!;
    old.closed(); old.reject(new Error("old load failed")); await firstRejected;
    assert.equal(f.lifecycle.open(f.account), second); assert.equal(f.windows.length, 2);
    current.resolve(); await second; assert.equal(current.shown, 1);
    const pending = f.lifecycle.open(f.other), pendingRejected = assert.rejects(pending, /关闭|失效/), last = f.windows[2]!;
    f.lifecycle.closeAll(); last.resolve(); await pendingRejected;
    assert.equal(last.shown, 0); assert.equal(current.destroyed, true);
    await assert.rejects(f.lifecycle.open(f.account), /关闭/); assert.equal(f.windows.length, 3);
  } finally { f.database.close(); }
});

test("failed initial load permits retry, while unverifiable failed destruction retains ownership and cannot create another window", async () => {
  const f = fixture(); try {
    const first = f.lifecycle.open(f.account), rejected = assert.rejects(first, /load failed/);
    f.windows[0]!.reject(new Error("load failed")); await rejected; assert.equal(f.windows[0]!.destroyed, true);
    const next = f.lifecycle.open(f.account), rejectedNext = assert.rejects(next, /验证/), window = f.windows[1]!;
    window.refuseDestroy = true; window.reject(new Error("load failed again")); await rejectedNext;
    await assert.rejects(f.lifecycle.open(f.account), /验证/); assert.equal(f.windows.length, 2);
    assert.throws(() => f.lifecycle.closeAll(), /验证/);
    window.refuseDestroy = false; f.lifecycle.closeAll(); assert.equal(window.destroyed, true);
  } finally { f.database.close(); }
});

test("missing/closed database and missing account fail closed without running native actions", () => {
  let called = false;
  assert.throws(() => new SqliteAccountSessionFence(() => null).present(randomUUID(), () => { called = true; }), /不可用/);
  const f = fixture();
  assert.throws(() => f.fence.present(randomUUID(), () => { called = true; }), /移除/);
  f.database.close(); assert.throws(() => f.fence.present(f.account.id, () => { called = true; }), /不可用/);
  assert.equal(called, false);
});


test("post-load show failure with failed destroy poisons entry; released or malformed lease never authorizes closing", async () => {
  const f = fixture(); try {
    const opening = f.lifecycle.open(f.account), rejected = assert.rejects(opening, /验证/), window = f.windows[0]!;
    window.throwShow = true; window.refuseDestroy = true; window.resolve(); await rejected;
    const shown = window.shown;
    await assert.rejects(f.lifecycle.open(f.account), /验证/); assert.equal(window.shown, shown);
    const lease = await f.begin(); await f.store.fail(lease);
    for (const bad of [lease, { ...lease, leaseToken: null }, { ...lease, operationId: "" }])
      assert.throws(() => f.lifecycle.closeForRemoval(bad as RemovalLease), /租约/);
    assert.equal(window.destroyedCalls, 1);
    window.refuseDestroy = false; f.lifecycle.closeAll();
  } finally { f.database.close(); }
});
