import test from "node:test";
import assert from "node:assert/strict";
import { canOpenTrayQueue } from "../src/shared/tray-navigation";
test("explicit tray queue navigation waits for canvas, dialog, work and initial load to finish", () => {
  const safe = { hasCanvas: false, hasDialog: false, busy: false, ready: true };
  assert.equal(canOpenTrayQueue(safe), true);
  for (const blocked of [{ hasCanvas: true }, { hasDialog: true }, { busy: true }, { ready: false }])
    assert.equal(canOpenTrayQueue({ ...safe, ...blocked }), false);
  assert.equal(canOpenTrayQueue({ ...safe, hasCanvas: true, hasDialog: true }), false);
  assert.equal(canOpenTrayQueue(safe), true); // A deferred request can be adopted after returning safely.
});
