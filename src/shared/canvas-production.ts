import type { PlanStyleContext } from "./prompts";
import type { CanvasPosition, Plan, TaskWorkspace } from "./models";
import { currentFrame, hasCurrentConfirmation } from "./frames";
import { findPrompt, PROMPT_LABELS, promptInput } from "./prompts";
import { resolvedProductionPositions } from "./canvas-layout";

export function productionNodes(workspace: TaskWorkspace, style: PlanStyleContext) {
  const positions = resolvedProductionPositions(workspace);
  const prompts = [
    ...workspace.shots.map((shot, index) => ({ id: `prompt:shot:${shot.id}`, kind: "shot" as const, shotId: shot.id,
      title: `${index + 1}. ${shot.title} · 提示词`, position: { x: 1180, y: 80 + index * 230 } })),
    ...(["video", "firstFrame", "lastFrame"] as const).map((kind, index) => ({ id: `prompt:${kind}`, kind, shotId: null,
      title: PROMPT_LABELS[kind], position: { x: 1560, y: 80 + index * 270 } })),
  ].map(item => {
    const prompt = findPrompt(workspace, item.kind, item.shotId);
    return { ...item, position: positions[item.id]!,
      summary: prompt?.text || "点击手动编辑提示词。", status: !prompt?.text.trim() ? "未填写"
        : prompt.inputSnapshot !== promptInput(workspace, style, item.kind, item.shotId) ? "待更新" : "已编辑",
      selection: item.kind === "shot" ? `shot:${item.shotId}` : item.kind };
  });
  const frames = (["first", "last"] as const).map((slot, index) => {
    const candidate = currentFrame(workspace, slot);
    const id = `frame:${slot}`;
    return { id, slot, title: slot === "first" ? "首帧图片" : "尾帧图片", candidate,
      position: positions[id]!,
      status: !candidate ? "未选择" : hasCurrentConfirmation(workspace, style) ? "已确认" : "待审核" };
  });
  return { prompts, frames };
}

export function productionEdges(workspace: TaskWorkspace) {
  const result = workspace.shots.flatMap(shot => [
    { source: shot.id, target: `prompt:shot:${shot.id}` },
    { source: `prompt:shot:${shot.id}`, target: "prompt:video" },
  ]);
  for (const slot of ["first", "last"] as const) {
    const kind = slot === "first" ? "firstFrame" : "lastFrame";
    const shot = slot === "first" ? workspace.shots[0] : workspace.shots.at(-1);
    if (shot) result.push({ source: shot.id, target: `prompt:${kind}` });
    result.push({ source: `prompt:${kind}`, target: `frame:${slot}` });
  }
  return result;
}

export function storeProductionPositions(workspace: TaskWorkspace, positions: Map<string, CanvasPosition>): Record<string, CanvasPosition> {
  const validIds = [...workspace.shots.map(shot => `prompt:shot:${shot.id}`), "prompt:video", "prompt:firstFrame", "prompt:lastFrame", "frame:first", "frame:last"];
  return Object.fromEntries(validIds.flatMap(id => {
    const position = positions.get(id) ?? workspace.productionPositions?.[id];
    return position ? [[id, position]] : [];
  }));
}

export function nextLocalStep(workspace: TaskWorkspace, style: PlanStyleContext): { label: string; target: string } {
  if (hasCurrentConfirmation(workspace, style)) return { label: "本地图片已确认，真实生成待接入", target: "frame:first" };
  const video = findPrompt(workspace, "video", null);
  if (currentFrame(workspace, "first") && currentFrame(workspace, "last")) {
    if (!video?.text.trim()) return { label: "填写视频提示词", target: "prompt:video" };
    const stale = productionNodes(workspace, style).prompts.find(prompt => prompt.kind !== "shot" && prompt.status === "待更新");
    if (stale) return { label: "核对提示词", target: stale.id };
    return { label: "审核两张图片", target: "frame:first" };
  }
  // Imported-image workflows do not require generated scripts, assets or optional prompts.
  if (video?.text.trim()) {
    const stale = productionNodes(workspace, style).prompts.find(prompt => prompt.kind !== "shot" && prompt.status === "待更新");
    if (stale) return { label: "核对提示词", target: stale.id };
    const missingSlot = currentFrame(workspace, "first") ? "last" : "first";
    return { label: missingSlot === "first" ? "导入首帧图片" : "导入尾帧图片", target: `frame:${missingSlot}` };
  }
  if (!workspace.script.trim()) return { label: "编辑剧本", target: "script" };
  if (!workspace.shots.length) return { label: "添加镜头", target: "add-shot" };
  if (!workspace.assets.length) return { label: "整理资产", target: "assets" };
  const { prompts, frames } = productionNodes(workspace, style);
  const incomplete = prompts.find(prompt => prompt.status === "待更新" || (prompt.kind === "video" && prompt.status === "未填写"));
  if (incomplete) return { label: incomplete.status === "待更新" ? "核对提示词" : "填写提示词", target: incomplete.id };
  const missing = frames.find(frame => !frame.candidate);
  if (missing) return { label: `导入${missing.title}`, target: missing.id };
  return { label: "审核两张图片", target: "frame:first" };
}
