import type { ProductionAsset, PromptKind, StoryboardShot, TaskWorkspace } from "./models";
import { effectiveStyleNotes, planStyleValue, type PlanStyleContext } from "./prompts";

/** Explicit local additions only. Nothing here is inferred, persisted, reviewed or generated. */
export interface PromptTemplateFields {
  tone?: string;
  lighting?: string;
  colorAnchor?: string;
  shots?: Record<string, {
    duration?: string;
    actionRequirements?: string;
    actionRhythm?: string;
    continuity?: string;
  }>;
  firstFrame?: { composition?: string; state?: string };
  lastFrame?: { composition?: string; state?: string };
  negativeConstraints?: string;
}
const filled = (value: string | undefined) => value?.trim() ? value : "未提供";
const line = (label: string, value: string | undefined) => `${label}：${filled(value)}`;
const assetText = (asset: ProductionAsset) => `${asset.name}${asset.description.trim() ? `：${asset.description}` : ""}${asset.referenceImageId ? "（已关联参考图，上传编号未提供；需用户指定对应关系）" : ""}`;

/** A read-only, deterministic local formatter, NOT a provider result or an editable draft update. */
export function formatPromptTemplate(workspace: TaskWorkspace, plan: PlanStyleContext,
  kind: PromptKind, shotId: string | null, fields: PromptTemplateFields = {}): string {
  if (!["shot", "video", "firstFrame", "lastFrame"].includes(kind)) throw new Error("提示词类型无效。");
  if (kind !== "shot" && shotId !== null) throw new Error("此提示词类型不能指定镜头。");
  const found = workspace.shots.find(shot => shot.id === shotId);
  if (kind === "shot" && !found) throw new Error("镜头已不存在。");
  const selected = kind === "shot" ? [found!] : kind === "firstFrame" ? workspace.shots.slice(0, 1)
    : kind === "lastFrame" ? workspace.shots.slice(-1) : workspace.shots;
  const linked = (shots: StoryboardShot[]) => {
    const ids = new Set(shots.map(shot => shot.id));
    const assetIds = new Set(workspace.assetLinks.filter(link => ids.has(link.shotId)).map(link => link.assetId));
    return workspace.assets.filter(asset => assetIds.has(asset.id));
  };
  const assets = linked(selected);
  const staticFrame = kind === "firstFrame" || kind === "lastFrame";
  const describeAsset = (asset: ProductionAsset) => staticFrame
    ? `${asset.name}${asset.referenceImageId ? "（已关联参考图，上传编号未提供；需用户指定对应关系）" : ""}` : assetText(asset);
  const people = assets.filter(asset => asset.type === "person");
  const style = workspace.promptSettings?.style ?? planStyleValue(plan);
  const header = [line("画质风格", style === "realistic" ? "偏真人" : "漫剧"), line("影片基调", fields.tone),
    line("光线设计", fields.lighting), line("角色绑定", people.map(asset => asset.name).join("；")),
    line("色彩锚点", fields.colorAnchor), line("场景锚点", assets.filter(asset => asset.type === "scene").map(describeAsset).join("；")),
    line("人物视觉锚点", people.map(describeAsset).join("；"))];
  const notes = effectiveStyleNotes(workspace, plan);
  if (!staticFrame && notes.trim()) header.push(line("补充风格说明（原文）", notes));
  if (kind === "firstFrame" || kind === "lastFrame") {
    const shot = selected[0];
    const explicit = fields[kind];
    // Shot description/action may describe a sequence. Never guess a frozen endpoint from it.
    return [...header, "", kind === "firstFrame" ? "首帧｜单张静态画面" : "尾帧｜单张静态画面",
      line("对应镜头", shot ? `Shot ${String(workspace.shots.indexOf(shot) + 1).padStart(2, "0")}｜${shot.title}` : undefined),
      line("景别", shot?.shotSize), line("静态构图", explicit?.composition),
      line(kind === "firstFrame" ? "起始静态状态" : "结束静态状态", explicit?.state),
      line("关联资产", assets.map(describeAsset).join("；"))].join("\n");
  }
  const sections = selected.map(shot => {
    const extra = fields.shots?.[shot.id];
    const camera = [shot.shotSize, shot.cameraMovement].filter(value => value.trim()).join("；");
    const rows = [`Shot ${String(workspace.shots.indexOf(shot) + 1).padStart(2, "0")}｜${shot.title}`,
      line("时长", extra?.duration), line("镜头", camera), line("描述内容", shot.description)];
    // Existing action is the supplied requirement, never a newly invented stunt or rhythm.
    if (shot.action.trim() || extra?.actionRequirements?.trim()) rows.push(line("动作要求", [shot.action, extra?.actionRequirements].filter(value => value?.trim()).join("\n")));
    if (extra?.actionRhythm?.trim()) rows.push(line("动作节奏", extra.actionRhythm));
    rows.push(line("声音设计", shot.audio), line("连续性约束", extra?.continuity),
      line("本镜头关联资产", linked([shot]).map(describeAsset).join("；")));
    return rows.join("\n");
  });
  const result = [...header, "", ...(kind === "video" ? ["整条视频｜按现有镜头顺序", ""] : []),
    sections.length ? sections.join("\n\n") : "未提供镜头"];
  if (kind === "video" && fields.negativeConstraints?.trim()) result.push("", line("负面约束", fields.negativeConstraints));
  return result.join("\n");
}
