import assert from "node:assert/strict";
import { test } from "node:test";
import { AppliedMutation } from "../src/shared/applied-mutation";

test("committed edit remains saved through repeated refresh failures; retry refresh cannot repeat mutation", async () => {
  const state = new AppliedMutation();
  let writes = 0, reads = 0;
  await state.commit(async () => { writes++; });
  assert.equal(state.applied, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(state.refresh(async () => { reads++; throw new Error("read failed"); }));
    assert.equal(state.applied, true);
  }
  await state.refresh(async () => { reads++; });
  await state.commit(async () => { writes++; });
  assert.equal(writes, 1); assert.equal(reads, 3);
});
test("failed mutation remains editable and may retry; refresh cannot imply success before commit", async () => {
  const state = new AppliedMutation();
  await assert.rejects(state.commit(async () => { throw new Error("write failed"); }));
  assert.equal(state.applied, false);
  let read = false;
  await assert.rejects(state.refresh(async () => { read = true; }));
  assert.equal(read, false);
  await state.commit(async () => {});
  assert.equal(state.applied, true);
});
