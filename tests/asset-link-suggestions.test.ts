import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewAssetLinks, adoptAssetLinkSuggestions } from "../src/shared/asset-link-suggestions";
import { addShot, editScript } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { editPrompt, promptInput } from "../src/shared/prompts";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import type { TaskWorkspace } from "../src/shared/models";
function services(path = ":memory:") {
  const database = new ApplicationDatabase(path);
  return { database, ...createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} }, version: "test", dataDirectory: "synthetic" }) };
}
function fixture(f: ReturnType<typeof services>) {
  const tasks = f.database.transaction(() => f.repository.createPlan({ title: "local suggestion", style: "realistic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" })).tasks;
  let w = addShot(addShot(editScript(tasks[0]!.workspace, "全局剧本不作为逐镜头建议依据"), randomUUID()), randomUUID());
  for (const name of ["巡桥员", "纸灯", "Alice", "Red Fox"]) { w = addAsset(w, randomUUID(), "person"); w.assets.at(-1)!.name = name; }
  w.shots[0]!.title = "巡桥员走近"; w.shots[0]!.description = "ＡＬＩＣＥ手持纸灯"; w.shots[1]!.action = "Red   Fox 跑开";
  return { w, tasks };
}

test("preview is pure deterministic local title/description/action evidence and excludes existing links", () => {
  const f = services(); try {
    const { w } = fixture(f), before = structuredClone(w), preview = previewAssetLinks(w);
    assert.deepEqual(w, before); assert.deepEqual(previewAssetLinks(w), preview); assert.equal(preview.suggestions.length, 4);
    assert.deepEqual(preview.suggestions.map(s => s.field), ["title", "description", "description", "action"]);
    assert.ok(preview.suggestions.every(s => s.evidence.trim()));
    const linked = setAssetLink(w, w.assets[0]!.id, w.shots[0]!.id, true);
    assert.equal(previewAssetLinks(linked).suggestions.length, 3);
    w.shots.forEach(s => { s.title = ""; s.description = ""; s.action = ""; s.audio = "巡桥员 Alice 纸灯"; });
    assert.equal(previewAssetLinks(w).suggestions.length, 0);
  } finally { f.database.close(); }
});

test("ambiguous normalized names, blanks, single characters and default placeholders produce no suggestions", () => {
  const f = services(); try {
    let { w } = fixture(f);
    for (const name of [" alice ", "  ", "剑", "未命名人物", "未命名场景", "未命名道具", "--"]) { w = addAsset(w, randomUUID(), "prop"); w.assets.at(-1)!.name = name; }
    w.shots[0]!.title = "Alice 剑 未命名人物 未命名场景 未命名道具 --"; w.shots[0]!.description = ""; w.shots[1]!.action = "";
    assert.deepEqual(previewAssetLinks(w).suggestions, []);
    assert.deepEqual(previewAssetLinks({ ...w, shots: [], assets: [] }).suggestions, []);
  } finally { f.database.close(); }
});

test("Latin token boundaries reject partial words but accept punctuation and Chinese adjacent text", () => {
  const f = services(); try {
    const { w } = fixture(f); w.shots = [w.shots[0]!]; w.assets = [w.assets[2]!];
    for (const text of ["Malice", "Alice2", "Alice_name", "xAlice", "Alicex", "Álice"]) {
      Object.assign(w.shots[0]!, { title: text, description: "", action: "" }); assert.equal(previewAssetLinks(w).suggestions.length, 0, text);
    }
    for (const text of ["Alice", "ALICE!", "看见Alice走来", "(alice)", "ＭＡＬＩＣＥ Alice"]) {
      w.shots[0]!.title = text; assert.equal(previewAssetLinks(w).suggestions.length, 1, text);
    }
  } finally { f.database.close(); }
});

test("adoption adds only explicit selected current suggestions, dedupes selection and preserves manual content/layout", () => {
  const f = services(); try {
    let { w } = fixture(f); w = setAssetLink(w, w.assets[0]!.id, w.shots[1]!.id, true);
    const preview = previewAssetLinks(w), selected = preview.suggestions[0]!;
    assert.equal(adoptAssetLinkSuggestions(w, preview, []), w);
    const next = adoptAssetLinkSuggestions(w, preview, [selected.id, selected.id]);
    assert.equal(next.assetLinks.length, 2); assert.deepEqual(next.assetLinks[0], w.assetLinks[0]);
    assert.deepEqual(next.assets, w.assets); assert.equal(next.script, w.script); assert.deepEqual(next.viewport, w.viewport);
    for (const shot of next.shots) { const old = w.shots.find(s => s.id === shot.id)!; const { assetsNeedReview: _a, ...a } = shot; const { assetsNeedReview: _b, ...b } = old; assert.deepEqual(a, b); }
    assert.throws(() => adoptAssetLinkSuggestions(w, preview, [selected.id, "invalid"]));
    assert.equal(w.assetLinks.length, 1);
    assert.throws(() => adoptAssetLinkSuggestions(next, preview, [selected.id]), /刷新/);
  } finally { f.database.close(); }
});

test("stale preview rejects content, identity and manual link changes but permits layout-only edits", () => {
  const f = services(); try {
    const { w } = fixture(f), preview = previewAssetLinks(w), ids = [preview.suggestions[0]!.id];
    const mutations: ((v: TaskWorkspace) => void)[] = [v => { v.shots[0]!.action += " changed"; }, v => { v.assets[0]!.name += " changed"; }, v => { v.assets[0]!.description += " changed"; }, v => { v.shots.pop(); }, v => { v.assets.pop(); }, v => { v.assetLinks.push({ shotId: v.shots[1]!.id, assetId: v.assets[1]!.id }); }];
    for (const mutate of mutations) { const copy = structuredClone(w); mutate(copy); assert.throws(() => adoptAssetLinkSuggestions(copy, preview, ids), /刷新/); }
    const moved = structuredClone(w); moved.shots[0]!.position.x += 100; moved.viewport.zoom = 1.2;
    assert.equal(adoptAssetLinkSuggestions(moved, preview, ids).shots[0]!.position.x, moved.shots[0]!.position.x);
    const tampered = { ...preview, suggestions: [{ ...preview.suggestions[0]!, assetId: w.assets[3]!.id }] };
    assert.equal(adoptAssetLinkSuggestions(w, tampered, ids).assetLinks[0]!.assetId, preview.suggestions[0]!.assetId);
  } finally { f.database.close(); }
});

test("adopted links persist on reopen and invalidate only affected prompt inputs through ordinary workspace save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suggestion-test-")), path = join(dir, "workspace.sqlite"); let f = services(path);
  try {
    let { w, tasks } = fixture(f);
    for (const shot of w.shots) w = editPrompt(w, "realistic", "shot", shot.id, "existing manual prompt");
    const before = structuredClone(w), preview = previewAssetLinks(w), selected = preview.suggestions.find(s => s.assetId === w.assets[1]!.id)!;
    const next = adoptAssetLinkSuggestions(w, preview, [selected.id]);
    assert.notEqual(promptInput(next, "realistic", "shot", w.shots[0]!.id), promptInput(before, "realistic", "shot", w.shots[0]!.id));
    assert.equal(promptInput(next, "realistic", "shot", w.shots[1]!.id), promptInput(before, "realistic", "shot", w.shots[1]!.id));
    assert.deepEqual(next.prompts, before.prompts);
    const response = await f.router.dispatch({ command: "tasks.saveWorkspace", requestId: randomUUID(), input: { id: tasks[0]!.id, expectedRevision: tasks[0]!.revision, workspace: next } }, { trusted: true });
    assert.equal(response.ok, true); f.database.close(); f = services(path);
    assert.deepEqual(f.repository.getTask(tasks[0]!.id).workspace.assetLinks, next.assetLinks);
    assert.equal(f.repository.getTask(tasks[0]!.id).workspace.shots[0]!.assetsNeedReview, true);
  } finally { f.database.close(); rmSync(dir, { recursive: true, force: true }); }
});
