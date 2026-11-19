import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { StoryboardCandidateSession, MAX_STORYBOARD_REPLY_CHARS } from "../src/shared/storyboard-candidate";
import { addShot } from "../src/shared/storyboard";
import type { TaskWorkspace } from "../src/shared/models";
const shot = (order = 1) => ({ order, title: "合成镜头", visual: "合成房间内一只蓝色方块。", action: "方块平移。", framing: "中景", motion: "固定", dialogue: "旁白：合成测试。" });
const raw = (shots = [shot()]) => JSON.stringify({ formatVersion: 1, shots });
function workspace() {
  return addShot({ script: "仅合成测试文本。", scriptPosition: { x: 1, y: 2 }, viewport: { x: 3, y: 4, zoom: 1 }, shots: [], assets: [], assetLinks: [] }, randomUUID());
}
test("strict ordered JSON maps every shot field without allocating production IDs or modifying current edits", () => {
  const session = new StoryboardCandidateSession(raw([shot(), { ...shot(2), title: "合成结尾" }]));
  assert.deepEqual(session.status, { status: "ready", shotCount: 2, rawRetained: true });
  const current = workspace(), before = structuredClone(current), preview = session.preview(current);
  assert.equal(preview.mode, "ordinal-comparison-only"); assert.equal(preview.extraCandidatePositions, 1); assert.equal(preview.extraCurrentPositions, 0);
  assert.equal(preview.rows[0]!.currentId, current.shots[0]!.id); assert.equal(preview.rows[1]!.currentId, null);
  assert.deepEqual(preview.rows[0]!.candidate, { title: "合成镜头", description: shot().visual, action: shot().action, shotSize: "中景", cameraMovement: "固定", audio: shot().dialogue });
  assert.equal("id" in preview.rows[0]!.candidate!, false); assert.deepEqual(current, before);
  assert.equal(Reflect.set(preview.rows[0]!.candidate!, "title", "overwrite"), false);
  assert.equal(preview.rows[0]!.candidate!.title, "合成镜头");
  assert.equal(session.isCurrent(preview, current), true);
});
test("invalid JSON/structure/order failures retain exact admitted raw privately and never echo payload in status or thrown error", () => {
  const privateText = "SYNTHETIC_SECRET_DO_NOT_LOG";
  const cases = [privateText, "```json\n" + raw() + "\n```", raw().slice(0, -1), JSON.stringify({ formatVersion: 2, shots: [shot()] }),
    raw([]), raw([shot(2), shot(1)]), raw([shot(), shot(1)]), JSON.stringify({ formatVersion: 1, shots: [{ ...shot(), password: privateText }] }),
    JSON.stringify({ formatVersion: 1, shots: [{ order: 1, title: privateText }] }), JSON.stringify({ formatVersion: 1, shots: [{ ...shot(), motion: null }] })];
  for (const input of cases) {
    const session = new StoryboardCandidateSession(input);
    assert.equal(session.status.status, "failed"); assert.equal(session.status.rawRetained, true); assert.equal(session.readRawReply(), input);
    assert.equal(JSON.stringify(session), "{}"); assert.equal(JSON.stringify(session.status).includes(privateText), false);
    assert.throws(() => session.preview(workspace()), error => error instanceof Error && !error.message.includes(privateText));
    session.discard(); assert.equal(session.readRawReply(), null); assert.equal(session.status.rawRetained, false);
  }
});
test("bounds align with saved shot fields and reject oversized input without truncation or invoking object hooks", () => {
  for (const [field, maximum] of [["title", 120], ["visual", 10000], ["action", 10000], ["framing", 120], ["motion", 500], ["dialogue", 10000]] as const) {
    assert.equal(new StoryboardCandidateSession(raw([{ ...shot(), [field]: "a".repeat(maximum) }])).status.status, "ready");
    assert.equal(new StoryboardCandidateSession(raw([{ ...shot(), [field]: "a".repeat(maximum + 1) }])).status.status, "failed");
  }
  assert.equal(new StoryboardCandidateSession(raw(Array.from({ length: 200 }, (_, i) => shot(i + 1)))).status.status, "ready");
  assert.equal(new StoryboardCandidateSession(raw(Array.from({ length: 201 }, (_, i) => shot(i + 1)))).status.status, "failed");
  const oversized = new StoryboardCandidateSession("x".repeat(MAX_STORYBOARD_REPLY_CHARS + 1));
  assert.equal(oversized.readRawReply(), null); assert.equal(oversized.status.rawRetained, false);
  let touched = false;
  const object = { get shots() { touched = true; throw new Error("no getters"); }, toJSON() { touched = true; throw new Error("no conversion"); } };
  assert.equal(new StoryboardCandidateSession(object).status.status, "failed"); assert.equal(touched, false);
});
test("comparison reports differences only by ordinal and invalidates stale edited/layout/reordered workspaces without any adoption", () => {
  const session = new StoryboardCandidateSession(raw());
  const current = addShot(workspace(), randomUUID()), baseline = structuredClone(current), preview = session.preview(current);
  assert.equal(preview.extraCurrentPositions, 1); assert.equal(preview.rows[1]!.candidate, null);
  const edits: TaskWorkspace[] = [
    { ...current, script: "合成文本修改" },
    { ...current, viewport: { x: 9, y: 9, zoom: 1 } },
    { ...current, shots: [...current.shots].reverse() },
    { ...current, shots: current.shots.map((s, i) => i ? s : { ...s, description: "保留人工修改" }) },
  ];
  for (const changed of edits) assert.equal(session.isCurrent(preview, changed), false);
  assert.equal(session.isCurrent(structuredClone(preview), current), false);
  assert.deepEqual(current, baseline);
  const fresh = session.preview(edits[3]!); assert.equal(fresh.rows[0]!.current!.description, "保留人工修改");
  assert.equal(session.isCurrent(fresh, edits[3]!), true);
  session.discard(); assert.equal(session.isCurrent(fresh, edits[3]!), false); assert.throws(() => session.preview(current));
});
