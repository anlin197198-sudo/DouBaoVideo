import type { PromptKind, TaskWorkspace } from "./models";
export interface TemplateInputGap {
  readonly code: string;
  readonly category: "field-unavailable" | "content-empty";
  readonly scope: "global" | "shot" | "firstFrame" | "lastFrame";
  readonly shotId: string | null;
  readonly label: string;
}
/** Describes ONLY the current renderer path (formatter called without optional explicit fields).
 * This is not a generic validator, submission gate or claim that every empty field is required.
 * Free prose, existing prompts and whole-video duration never supply missing structured fields. */
export function getTemplateInputGaps(workspace: TaskWorkspace, kind: PromptKind, shotId: string | null) {
  if (!["shot", "video", "firstFrame", "lastFrame"].includes(kind)) throw new Error("提示词类型无效。");
  if (kind !== "shot" && shotId !== null) throw new Error("此提示词类型不能指定镜头。");
  const shot = workspace.shots.find(item => item.id === shotId);
  if (kind === "shot" && !shot) throw new Error("镜头已不存在。");
  const selected = kind === "shot" ? [shot!] : kind === "firstFrame" ? workspace.shots.slice(0, 1)
    : kind === "lastFrame" ? workspace.shots.slice(-1) : workspace.shots;
  const staticFrame = kind === "firstFrame" || kind === "lastFrame";
  const gaps: TemplateInputGap[] = [];
  const add = (code: string, label: string, category: TemplateInputGap["category"], scope: TemplateInputGap["scope"], id: string | null = null) =>
    gaps.push(Object.freeze({ code, label, category, scope, shotId: id }));
  for (const [code, label] of [["tone", "影片基调"], ["lighting", "光线设计"], ["colorAnchor", "色彩锚点"]])
    add(code!, `${label}：当前入口没有独立结构化输入`, "field-unavailable", "global");
  if (!selected.length) add("shots", "尚无对应镜头内容", "content-empty", staticFrame ? kind : "global");
  if (staticFrame) {
    add("composition", "静态构图：当前入口没有独立结构化输入", "field-unavailable", kind, selected[0]?.id ?? null);
    add("state", `${kind === "firstFrame" ? "起始" : "结束"}静态状态：当前入口没有独立结构化输入`, "field-unavailable", kind, selected[0]?.id ?? null);
  }
  for (const current of selected) {
    const scope = staticFrame ? kind : "shot";
    if (!staticFrame) {
      add("duration", "镜头时长：当前入口没有独立结构化输入", "field-unavailable", scope, current.id);
      add("continuity", "连续性约束：当前入口没有独立结构化输入", "field-unavailable", scope, current.id);
      if (!current.description.trim()) add("description", "镜头描述尚未填写（信息提示）", "content-empty", scope, current.id);
      if (!current.audio.trim()) add("audio", "声音设计尚未填写（信息提示，可能有意留空）", "content-empty", scope, current.id);
    }
    if (staticFrame ? !current.shotSize.trim() : !current.shotSize.trim() && !current.cameraMovement.trim())
      add("camera", staticFrame ? "静态景别尚未填写（信息提示）" : "景别及运镜尚未填写（信息提示）", "content-empty", scope, current.id);
    const assets = workspace.assets.filter(asset => workspace.assetLinks.some(link => link.shotId === current.id && link.assetId === asset.id));
    if (!assets.length) add("assetLinks", "此镜头没有关联资产（信息提示，不要求必须关联）", "content-empty", scope, current.id);
    if (assets.some(asset => asset.referenceImageId)) add("referenceMapping", "参考图上传编号及对应关系未提供；本地图片 ID 不能代替", "field-unavailable", scope, current.id);
  }
  return Object.freeze({ readiness: "manual-completion-required" as const, canFill: false as const, gaps: Object.freeze(gaps),
    notice: "仅检查当前只读模板入口；缺少的结构化输入须人工补充，内容空项仅供检查，不代表提交必填。未检查生成或发送能力。" });
}
