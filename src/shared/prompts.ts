import type { Plan, ProductionPrompt, PromptKind, TaskWorkspace } from "./models";

export type PlanStyleContext = Plan["style"] | { style: Plan["style"]; styleNotes?: string };
export const planStyleValue = (plan: PlanStyleContext) => typeof plan === "string" ? plan : plan.style;
export function inheritsStyleNotes(workspace: TaskWorkspace): boolean {
  const settings = workspace.promptSettings;
  return settings?.notesMode ? settings.notesMode === "inherit" : !settings?.notes;
}
export function effectiveStyleNotes(workspace: TaskWorkspace, plan: PlanStyleContext): string {
  return inheritsStyleNotes(workspace) ? typeof plan === "string" ? "" : plan.styleNotes ?? "" : workspace.promptSettings?.notes ?? "";
}
export function updatePromptSettings(workspace: TaskWorkspace, plan: PlanStyleContext, settings: NonNullable<TaskWorkspace["promptSettings"]>): TaskWorkspace {
  const next = { ...workspace, promptSettings: settings };
  const changed = effectiveStyleNotes(workspace, plan) !== effectiveStyleNotes(next, plan)
    || (workspace.promptSettings?.style ?? planStyleValue(plan)) !== (settings.style ?? planStyleValue(plan));
  return changed && next.frames?.confirmation ? { ...next, frames: { ...next.frames,
    confirmation: { ...next.frames.confirmation, invalidated: true } } } : next;
}

export const PROMPT_LABELS: Record<PromptKind, string> = {
  shot: "镜头提示词", video: "整条视频提示词", firstFrame: "首帧图片提示词", lastFrame: "尾帧图片提示词",
};

export function promptInput(workspace: TaskWorkspace, planStyle: PlanStyleContext, kind: PromptKind, shotId: string | null): string {
  const style = workspace.promptSettings?.style ?? planStyleValue(planStyle);
  const shot = workspace.shots.find(item => item.id === shotId);
  if (kind === "shot" && !shot) throw new Error("镜头已不存在。");
  const selected = kind === "shot" ? [shot!] : kind === "firstFrame" ? workspace.shots.slice(0, 1)
    : kind === "lastFrame" ? workspace.shots.slice(-1) : workspace.shots;
  return JSON.stringify({ style: style === "realistic" ? "偏真人" : "漫剧", styleNotes: effectiveStyleNotes(workspace, planStyle),
    purpose: kind === "firstFrame" ? "一张静态首帧：构图和起始状态" : kind === "lastFrame" ? "一张静态尾帧：构图和结束状态"
      : kind === "video" ? "从首帧到尾帧的动作与镜头变化" : "当前镜头的画面、动作与运镜",
    script: workspace.script,
    shots: selected.map(item => ({ id: item.id, order: workspace.shots.findIndex(s => s.id === item.id) + 1,
      title: item.title, description: item.description, action: item.action, shotSize: item.shotSize,
      cameraMovement: item.cameraMovement, audio: item.audio,
      ...(kind === "video" ? { shotPrompt: findPrompt(workspace, "shot", item.id)?.text ?? "" } : {}),
      assets: workspace.assets.filter(asset => workspace.assetLinks.some(link => link.shotId === item.id && link.assetId === asset.id))
        .sort((a, b) => a.id.localeCompare(b.id)).map(asset => ({ id: asset.id, type: asset.type, name: asset.name,
          description: asset.description, referenceImageId: asset.referenceImageId })),
    })),
  }, null, 2);
}

export function findPrompt(workspace: TaskWorkspace, kind: PromptKind, shotId: string | null): ProductionPrompt | undefined {
  return workspace.prompts?.find(prompt => prompt.kind === kind && prompt.shotId === shotId);
}

export function editPrompt(workspace: TaskWorkspace, planStyle: PlanStyleContext, kind: PromptKind, shotId: string | null, text: string): TaskWorkspace {
  const current = findPrompt(workspace, kind, shotId);
  const prompt: ProductionPrompt = { kind, shotId, text, version: current?.version ?? 1, source: "manual",
    inputSnapshot: current?.inputSnapshot ?? promptInput(workspace, planStyle, kind, shotId) };
  return { ...workspace, prompts: [...(workspace.prompts ?? []).filter(item => item !== current), prompt] };
}

/** Explicit review never overwrites edited text or unrelated prompts. */
export function reviewPrompt(workspace: TaskWorkspace, planStyle: PlanStyleContext, kind: PromptKind, shotId: string | null): TaskWorkspace {
  const current = findPrompt(workspace, kind, shotId);
  if (!current) return workspace;
  return { ...workspace, prompts: workspace.prompts!.map(item => item === current
    ? { ...item, inputSnapshot: promptInput(workspace, planStyle, kind, shotId) } : item) };
}
