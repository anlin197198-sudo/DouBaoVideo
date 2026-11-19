import test from "node:test";
import assert from "node:assert/strict";
import { capturePlanList, planListContext, type PlanListView } from "../src/shared/plan-list-view";

test("list return restores selected date, scroll and disclosure context without mutating the original view", () => {
  const original: PlanListView = { planId: null, day: 4 };
  const saved = capturePlanList(original, "plan-a", "2026-11-22", 632.5, true, true);
  assert.deepEqual(original, { planId: null, day: 4 });
  assert.equal(saved.planId, "plan-a"); assert.equal(saved.day, 4);
  assert.deepEqual(planListContext(saved, "plan-a", "2026-11-22"), {
    planId: "plan-a", businessDate: "2026-11-22", scrollY: 632.5, archivedOpen: true, historicalOpen: true,
  });
  const later = capturePlanList(saved, "plan-a", "2026-11-22", 180, false, true);
  assert.equal(later.context!.archivedOpen, false); assert.equal(saved.context!.archivedOpen, true);
});

test("plan/date changes and missing plans never reuse another list position", () => {
  const saved = capturePlanList({ planId: "plan-a", day: 2 }, "plan-a", "2026-11-20", 700, true, false);
  assert.equal(planListContext(saved, "plan-b", "2026-11-20"), null);
  assert.equal(planListContext(saved, "plan-a", "2026-11-21"), null); // schedule edit changed actual date at same index
  assert.equal(planListContext(saved, undefined, undefined), null);
  assert.equal(planListContext({ planId: "plan-a", day: 2 }, "plan-a", "2026-11-20"), null);
});

test("scroll coordinates are bounded to finite non-negative values and reads return independent snapshots", () => {
  for (const y of [-10, NaN, Infinity, -Infinity]) {
    const saved = capturePlanList({ planId: "a", day: 0 }, "a", "2026-11-18", y, false, false);
    assert.equal(saved.context!.scrollY, 0);
  }
  const saved = capturePlanList({ planId: "a", day: 0 }, "a", "2026-11-18", 20, true, false);
  const restored = planListContext(saved, "a", "2026-11-18")!; restored.scrollY = 300;
  assert.equal(saved.context!.scrollY, 20);
});
