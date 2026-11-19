import assert from "node:assert/strict";
import test from "node:test";
import { storyboardApprovalOwner } from "../src/main/application/storyboard-dialog-owner";
import { StoryboardPanelLifecycle } from "../src/shared/storyboard-panel-lifecycle";

test("closing just the candidate discards a delayed adoption without blocking the next request", async () => {
  const scope = new StoryboardPanelLifecycle();
  scope.update("a", 7, true);
  const owned = scope.capture("a", 7)!;
  let settle!: () => void;
  let adopted = false;
  const delivery = new Promise<void>(resolve => { settle = resolve; }).then(() => { if (owned()) adopted = true; });
  scope.cancel();
  settle();
  await delivery;
  assert.equal(adopted, false);
  assert.equal(scope.capture("a", 7)?.(), true);
});

test("same revision task switches, temporary dirty states and close/reopen invalidate old ownership", () => {
  const scope = new StoryboardPanelLifecycle();
  scope.update("a", 7, true);
  const oldTask = scope.capture("a", 7)!;
  scope.update("b", 7, true);
  assert.equal(oldTask(), false);
  assert.equal(scope.capture("a", 7), null);
  const seen = scope.capture("b", 7)!;
  scope.update("b", 7, true);
  assert.equal(seen(), true);
  scope.update("b", 7, false);
  assert.equal(scope.capture("b", 7), null);
  scope.update("b", 7, true);
  assert.equal(seen(), false);
  const beforeClose = scope.capture("b", 7)!;
  scope.close();
  scope.update("b", 7, true);
  assert.equal(beforeClose(), false);
  const beforeSave = scope.capture("b", 7)!;
  scope.update("b", 8, true);
  assert.equal(beforeSave(), false);
});

test("a native approval cannot survive document replacement in the same window, destruction or window switch", () => {
  const window = { epoch: 1, live: true }, replacement = { epoch: 1, live: true };
  let owner: typeof window | null = window;
  const capture = () => storyboardApprovalOwner(window, () => owner, w => w.epoch, w => w.live);
  const beforeReload = capture();
  assert.equal(beforeReload(), true);
  window.epoch++;
  assert.equal(beforeReload(), false);
  const afterReload = capture();
  assert.equal(afterReload(), true);
  owner = replacement;
  assert.equal(afterReload(), false);
  owner = window;
  window.live = false;
  assert.equal(afterReload(), false);
  owner = null;
  assert.equal(afterReload(), false);
});
