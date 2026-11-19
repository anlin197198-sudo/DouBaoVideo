import assert from "node:assert/strict";
import test from "node:test";
import { imagePreview, refreshImagePreviews, settleImagePreview } from "../src/shared/image-preview-state";
test("repair refresh resets only that image to pending; stale load/error cannot override the new epoch", () => {
  const failed = settleImagePreview(settleImagePreview({}, "shared-first-last", 0, "failed"), "other", 0, "failed");
  const refreshed = refreshImagePreviews(failed, ["shared-first-last", "shared-first-last"]);
  assert.deepEqual(imagePreview(refreshed, "shared-first-last"), { epoch: 1, status: "pending" });
  assert.deepEqual(imagePreview(refreshed, "other"), { epoch: 0, status: "failed" });
  assert.equal(settleImagePreview(refreshed, "shared-first-last", 0, "ready"), refreshed);
  assert.equal(settleImagePreview(refreshed, "shared-first-last", 0, "failed"), refreshed);
  const ready = settleImagePreview(refreshed, "shared-first-last", 1, "ready");
  assert.equal(imagePreview(ready, "shared-first-last").status, "ready");
  assert.equal(settleImagePreview(ready, "shared-first-last", 0, "failed"), ready);
  const recheck = refreshImagePreviews(ready, ["shared-first-last"]);
  assert.deepEqual(imagePreview(recheck, "shared-first-last"), { epoch: 2, status: "pending" });
  assert.equal(settleImagePreview(recheck, "shared-first-last", 1, "ready"), recheck);
  assert.equal(imagePreview(failed, "shared-first-last").status, "failed");
});
