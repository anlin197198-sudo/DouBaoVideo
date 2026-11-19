/** A window-lifetime transport; no Electron event object crosses the bridge. */
export function createQueueSubscription(transport: {
  listen(signal: () => void): void;
  consume(): Promise<unknown>;
}): (callback: () => void) => () => void {
  const callbacks = new Set<() => void>();
  let started = false, running = false, again = false, buffered = false;
  function deliver() {
    if (!buffered || callbacks.size === 0) return;
    buffered = false;
    for (const callback of [...callbacks]) {
      if (callbacks.has(callback)) {
        try { callback(); } catch { /* One consumer must not break the IPC transport. */ }
      }
    }
  }
  async function poll() {
    if (running) { again = true; return; }
    running = true;
    do {
      again = false;
      try { if (await transport.consume() === true) buffered = true; }
      catch { /* No navigation on failure; next signal/subscription retries. */ }
      deliver();
    } while (again);
    running = false;
  }
  return callback => {
    if (typeof callback !== "function") throw new TypeError("Queue callback must be a function");
    callbacks.add(callback);
    if (!started) { started = true; transport.listen(() => { void poll(); }); }
    // Async delivery also lets React establish the cleanup before any callback.
    void Promise.resolve().then(() => { deliver(); void poll(); });
    return () => { callbacks.delete(callback); };
  };
}
