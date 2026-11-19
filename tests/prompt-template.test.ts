import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskWorkspace } from "../src/shared/models";
import { formatPromptTemplate } from "../src/shared/prompt-template";

function workspace(): TaskWorkspace {
  return { script: "剧本不是供格式器复制的模板", viewport: { x: 0, y: 0, zoom: 1 }, scriptPosition: { x: 1, y: 2 },
    shots: ["one", "two"].map((id, i) => ({ id, title: `测试${i + 1}`, description: `动态描述${i + 1}`,
      action: `动作原文${i + 1}`, shotSize: i ? "远景" : "近景", cameraMovement: `运镜原文${i + 1}`,
      audio: `声音原文${i + 1}`, position: { x: i * 10, y: 5 }, needsReview: true })),
    assets: ["person", "scene", "prop", "person"].map((type, i) => ({ id: `asset${i}`, name: `资产名${i}`,
      type: type as "person" | "scene" | "prop", description: `动态资产描述${i}`, referenceImageId: `image${i}`,
      version: 2, needsReview: false, position: { x: 0, y: i } })),
    assetLinks: [{ shotId: "one", assetId: "asset0" }, { shotId: "one", assetId: "asset1" },
      { shotId: "two", assetId: "asset0" }, { shotId: "two", assetId: "asset2" }],
    prompts: [{ kind: "video", shotId: null, text: "已编辑提示词绝不可覆盖", source: "manual", version: 9, inputSnapshot: "旧输入" }],
    frames: { candidates: [], firstId: null, lastId: null, parameters: { aspectRatio: "16:9", durationSeconds: 10 },
      confirmation: { confirmedAt: "fixed", inputSnapshot: "unchanged", invalidated: false } } };
}
const plan = { style: "realistic" as const, styleNotes: "计划风格原文" };

test("stable global and shot order, only scoped links, no made-up timing or mutation", () => {
  const w = workspace(), before = structuredClone(w);
  const text = formatPromptTemplate(w, plan, "video", null);
  const globals = ["画质风格", "影片基调", "光线设计", "角色绑定", "色彩锚点", "场景锚点", "人物视觉锚点"];
  assert.deepEqual(text.split("\n").slice(0, 7).map(row => row.split("：")[0]), globals);
  assert.match(text, /画质风格：偏真人/); assert.match(text, /补充风格说明（原文）：计划风格原文/);
  assert.match(text, /时长：未提供/); assert.doesNotMatch(text, /10秒|5秒|负面约束|资产名3|剧本不是/);
  assert.ok(text.indexOf("Shot 01｜测试1") < text.indexOf("Shot 02｜测试2"));
  const first = text.split("Shot 01｜测试1")[1]!.split("Shot 02｜")[0]!;
  assert.deepEqual(first.trim().split("\n").map(row => row.split("：")[0]),
    ["时长", "镜头", "描述内容", "动作要求", "声音设计", "连续性约束", "本镜头关联资产"]);
  assert.doesNotMatch(first, /资产名2/);
  const single = formatPromptTemplate(w, plan, "shot", "two");
  assert.doesNotMatch(single, /资产名1|动态描述1|声音原文1/); assert.match(single, /资产名2/);
  assert.doesNotMatch(text, /image[0-3]|图一|图二/);
  assert.match(text, /上传编号未提供；需用户指定对应关系/);
  assert.equal(text, formatPromptTemplate(w, plan, "video", null)); assert.deepEqual(w, before);
});

test("explicit fields preserve supplied wording and effective style without treating notes as light or tone", () => {
  const w = workspace(); w.promptSettings = { style: "comic", notesMode: "override", notes: "任务独立原文" };
  const text = formatPromptTemplate(w, plan, "video", null, { tone: "克制", lighting: "用户光线", colorAnchor: "用户色彩",
    shots: { one: { duration: "用户指定时长", actionRequirements: "附加动作", actionRhythm: "明确节奏", continuity: "明确连续性" } },
    negativeConstraints: "仅明确负面词" });
  assert.match(text, /画质风格：漫剧/); assert.doesNotMatch(text, /计划风格原文/);
  for (const value of ["影片基调：克制", "光线设计：用户光线", "色彩锚点：用户色彩", "时长：用户指定时长", "动作节奏：明确节奏", "连续性约束：明确连续性", "负面约束：仅明确负面词"]) assert.ok(text.includes(value));
  assert.ok(text.endsWith("负面约束：仅明确负面词"));
  w.promptSettings.notes = "";
  assert.doesNotMatch(formatPromptTemplate(w, plan, "video", null), /补充风格说明|计划风格原文/);
  w.shots[0]!.action = "";
  assert.doesNotMatch(formatPromptTemplate(w, plan, "shot", "one"), /动作要求|动作节奏/);
});

test("first and last are distinct static endpoints, never guessed from dynamic fields including asset prose", () => {
  const w = workspace();
  for (const kind of ["firstFrame", "lastFrame"] as const) {
    const text = formatPromptTemplate(w, plan, kind, null, { shots: { one: { duration: "99秒", actionRhythm: "跳跃" } },
      firstFrame: { composition: "明确起始构图", state: "明确起始姿态" }, lastFrame: { composition: "明确结束构图", state: "明确结束姿态" } });
    assert.doesNotMatch(text, /动态描述|动作原文|运镜原文|声音原文|动态资产描述|时长|声音设计|动作要求|动作节奏|99秒|跳跃|计划风格原文|补充风格说明/);
    assert.ok(text.includes(kind === "firstFrame" ? "Shot 01｜测试1" : "Shot 02｜测试2"));
    assert.ok(text.includes(kind === "firstFrame" ? "起始静态状态：明确起始姿态" : "结束静态状态：明确结束姿态"));
    assert.doesNotMatch(text, kind === "firstFrame" ? /资产名2|明确结束/ : /资产名1|明确起始/);
  }
  assert.match(formatPromptTemplate(w, plan, "lastFrame", null), /结束静态状态：未提供/);
  const reverse = { ...w, shots: [...w.shots].reverse() };
  assert.match(formatPromptTemplate(reverse, plan, "firstFrame", null), /Shot 01｜测试2/);
});

test("empty, single, stale or mismatched scope and unrelated layout do not invent content", () => {
  const w = workspace(), empty = { ...w, shots: [], assetLinks: [] };
  assert.match(formatPromptTemplate(empty, plan, "video", null), /未提供镜头/);
  assert.match(formatPromptTemplate(empty, plan, "firstFrame", null), /对应镜头：未提供/);
  assert.throws(() => formatPromptTemplate(w, plan, "shot", "missing"), /不存在/);
  assert.throws(() => formatPromptTemplate(w, plan, "video", "one"), /不能指定/);
  assert.throws(() => formatPromptTemplate(w, plan, "bad" as never, null), /类型无效/);
  const one = { ...w, shots: w.shots.slice(0, 1) };
  assert.match(formatPromptTemplate(one, plan, "lastFrame", null), /Shot 01｜测试1/);
  const moved = structuredClone(w); moved.shots[0]!.position.x = 999; moved.assets[3]!.description = "无关";
  assert.equal(formatPromptTemplate(moved, plan, "video", null), formatPromptTemplate(w, plan, "video", null));
});
