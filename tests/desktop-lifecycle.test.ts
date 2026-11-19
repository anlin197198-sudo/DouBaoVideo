import assert from "node:assert/strict";
import test from "node:test";
import { DesktopLifecycle, type DesktopActions } from "../src/main/application/desktop-lifecycle";
import { createQueueSubscription } from "../src/shared/queue-subscription";
function fixture(fail = false) {
  const calls: string[] = [];
  let destroyed = false, minimized = true, trayDestroyed = false, actions!: DesktopActions;
  const window = { isDestroyed: () => destroyed, isMinimized: () => minimized,
    restore: () => { calls.push("restore"); minimized = false; }, show: () => calls.push("show"), focus: () => calls.push("focus"), hide: () => calls.push("hide") };
  const lifecycle = new DesktopLifecycle({ window: () => window,
    createWindow: async () => { calls.push("recreate"); destroyed = false; }, openFailed: () => calls.push("open-failed"),
    createTray: value => { actions = value; calls.push("create"); if (fail) throw new Error("no tray"); return { isDestroyed: () => trayDestroyed, destroy: () => { calls.push("destroy"); trayDestroyed = true; } }; },
    signalQueue: () => calls.push("signal"), quit: () => calls.push("quit"), cleanup: () => calls.push("cleanup") });
  return { lifecycle, calls, actions: () => actions, destroyWindow: () => { destroyed = true; }, destroyTray: () => { trayDestroyed = true; } };
}
test("valid tray alone hides minimized window; open restores/shows/focuses existing window without reload", () => {
  const f = fixture();
  assert.equal(f.lifecycle.minimize(), false);
  assert.equal(f.lifecycle.start(), true); assert.equal(f.lifecycle.start(), true);
  assert.equal(f.lifecycle.minimize(), true);
  f.actions().open(); f.lifecycle.open(); // second-instance uses identical path
  assert.deepEqual(f.calls, ["create", "hide", "restore", "show", "focus", "show", "focus"]);
  f.destroyTray(); assert.equal(f.lifecycle.minimize(), false);
  f.destroyWindow(); f.lifecycle.open(); assert.equal(f.calls.at(-1), "focus");
  const failed = fixture(true); assert.equal(failed.lifecycle.start(), false); assert.equal(failed.lifecycle.minimize(), false);
  assert.deepEqual(failed.calls, ["create"]);
});
test("quit request never destroys resources before confirmed will-quit; veto leaves open and queue usable", () => {
  const f = fixture(); f.lifecycle.start(); f.actions().exit();
  assert.deepEqual(f.calls, ["create", "restore", "show", "focus", "quit"]);
  // Simulate Electron veto: willQuit is not emitted.
  f.actions().queue(); assert.equal(f.lifecycle.consumeQueue(true, []), true); f.actions().open();
  assert.ok(!f.calls.includes("cleanup")); assert.ok(!f.calls.includes("destroy"));
  f.actions().exit(); f.lifecycle.willQuit(); f.lifecycle.willQuit();
  assert.equal(f.calls.filter(c => c === "cleanup").length, 1); assert.equal(f.calls.filter(c => c === "destroy").length, 1);
  const before = [...f.calls]; f.lifecycle.open(); f.lifecycle.exit(); f.lifecycle.requestQueue();
  assert.deepEqual(f.calls, before); assert.equal(f.lifecycle.start(), false);
});
test("queue intent coalesces before renderer startup and only trusted empty-argument consume clears it", () => {
  const f = fixture(); f.lifecycle.start(); f.actions().queue(); f.actions().queue();
  assert.equal(f.lifecycle.consumeQueue(false, []), false);
  assert.equal(f.lifecycle.consumeQueue(true, ["arbitrary-route"]), false);
  assert.equal(f.lifecycle.consumeQueue(true, [{}]), false);
  assert.equal(f.lifecycle.consumeQueue(true, []), true); assert.equal(f.lifecycle.consumeQueue(true, []), false);
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("preload listens before startup consume, does not expose event payload, and buffers a consumed intent across unsubscribe", async () => {
  let signal!: () => void, resolve!: (value: unknown) => void, calls = 0;
  const order: string[] = [];
  const subscribe = createQueueSubscription({ listen: cb => { signal = cb; order.push("listen"); }, consume: () => { order.push("consume"); return new Promise(r => { resolve = r; }); } });
  const off = subscribe(() => { calls++; }); await tick();
  assert.deepEqual(order, ["listen", "consume"]);
  off(); resolve(true); await tick(); assert.equal(calls, 0);
  const off2 = subscribe((...args: unknown[]) => { assert.equal(args.length, 0); calls++; }); await tick();
  assert.equal(calls, 1); assert.equal(order.filter(x => x === "listen").length, 1);
  resolve(false); await tick(); signal(); await tick(); resolve("not-a-boolean"); await tick(); assert.equal(calls, 1);
  off2(); signal(); await tick(); resolve(true); await tick(); assert.equal(calls, 1);
});
test("preload serializes overlapping signals and retries rejected consume without generating navigation", async () => {
  let signal!: () => void;
  const pending: Array<{ resolve(value: unknown): void; reject(reason: Error): void }> = [];
  let received = 0;
  const subscribe = createQueueSubscription({ listen: cb => { signal = cb; }, consume: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const off = subscribe(() => { received++; }); await tick();
  signal(); signal(); assert.equal(pending.length, 1);
  pending[0]!.reject(new Error("startup unavailable")); await tick(); assert.equal(pending.length, 2); assert.equal(received, 0);
  pending[1]!.resolve(true); await tick(); assert.equal(received, 1);
  off(); signal(); await tick(); pending[2]!.resolve(false); await tick(); assert.equal(received, 1);
});

test("missing main window with other windows alive is recreated once; queue intent survives pending creation", async () => {
  let window: ReturnType<typeof fixture> | null = null, resolve!: () => void, creates = 0, failures = 0, shown = 0;
  const lifecycle = new DesktopLifecycle({
    window: () => window ? { isDestroyed: () => false, isMinimized: () => false, restore() {}, hide() {}, show() { shown++; }, focus() {} } : null,
    createWindow: () => { creates++; window = fixture(); return new Promise<void>(r => { resolve = r; }); },
    openFailed: () => { failures++; }, createTray: () => ({ isDestroyed: () => false, destroy() {} }), signalQueue() {}, quit() {}, cleanup() {},
  });
  lifecycle.open(); lifecycle.open(); lifecycle.requestQueue(); await tick(); assert.equal(creates, 1); assert.equal(shown, 0);
  lifecycle.open(); lifecycle.requestQueue(); await tick(); assert.equal(creates, 1); assert.equal(shown, 0);
  assert.equal(lifecycle.consumeQueue(false, []), false);
  resolve(); await tick(); assert.equal(shown, 1); assert.equal(lifecycle.consumeQueue(true, []), true);
  lifecycle.open(); await tick(); assert.equal(creates, 1); assert.equal(failures, 0);
});

test("recreation failure can retry; disposal before creation or before its completion does not show a window", async () => {
  let createCount = 0, failures = 0, shown = 0, available = false;
  let finish!: () => void;
  const deps = {
    window: () => available ? { isDestroyed: () => false, isMinimized: () => false, restore() {}, hide() {}, show() { shown++; }, focus() {} } : null,
    createWindow: async () => { createCount++; if (createCount === 1) throw new Error("load failed"); await new Promise<void>(r => { finish = () => { available = true; r(); }; }); },
    openFailed: () => { failures++; }, createTray: () => ({ isDestroyed: () => false, destroy() {} }), signalQueue() {}, quit() {}, cleanup() {},
  };
  const lifecycle = new DesktopLifecycle(deps);
  lifecycle.open(); await tick(); assert.equal(failures, 1);
  lifecycle.open(); await tick(); assert.equal(createCount, 2);
  lifecycle.willQuit(); finish(); await tick(); assert.equal(shown, 0);
  available = false;
  const disposed = new DesktopLifecycle(deps); disposed.open(); disposed.willQuit(); await tick(); assert.equal(createCount, 2);
});
