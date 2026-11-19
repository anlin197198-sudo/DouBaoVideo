import type { TemporaryTemplateApply } from "../../../shared/temporary-template-apply";
import type { InspectionSaveState } from "../../../shared/inspection-summary";
import { PromptTemplatePreview } from "./PromptTemplatePreview";
import type { PlanStyleContext } from "../../../shared/prompts";
import { PromptHistory } from "./PromptHistory";
import { useEffect, useState } from "react";
import type { Plan, PromptKind, TaskWorkspace } from "../../../shared/models";
import { editPrompt, findPrompt, PROMPT_LABELS, promptInput, reviewPrompt, planStyleValue, effectiveStyleNotes, inheritsStyleNotes, updatePromptSettings } from "../../../shared/prompts";

export function PromptPanel({ taskId, savedRevision, saveState, onApplyTemplate, workspace, planStyle, disabled, restoreDisabled, onChange, onClose, initialSelection = "video" }: {
  taskId: string;
  savedRevision: number;
  saveState: InspectionSaveState;
  onApplyTemplate: TemporaryTemplateApply;
  workspace: TaskWorkspace; planStyle: PlanStyleContext; disabled: boolean; restoreDisabled: boolean;
  onChange: (workspace: TaskWorkspace) => void; onClose: () => void;
  initialSelection?: string;
}) {
  const [selection, setSelection] = useState(initialSelection);
  useEffect(() => setSelection(initialSelection), [initialSelection]);
  const kind: PromptKind = selection.startsWith("shot:") ? "shot" : selection as PromptKind;
  const shotId = kind === "shot" ? selection.slice(5) : null;
  const valid = kind !== "shot" || workspace.shots.some(shot => shot.id === shotId);
  const input = valid ? promptInput(workspace, planStyle, kind, shotId) : "";
  const current = findPrompt(workspace, kind, shotId);
  const stale = current && current.inputSnapshot !== input;
  const settings = workspace.promptSettings ?? { style: null, notes: "" };
  const options = [
    ...workspace.shots.map((shot, index) => ({ value: `shot:${shot.id}`, kind: "shot" as const, shotId: shot.id, label: `${index + 1}. ${shot.title}` })),
    ...(["video", "firstFrame", "lastFrame"] as const).map(item => ({ value: item, kind: item, shotId: null, label: PROMPT_LABELS[item] })),
  ];
  return <section className="prompt-panel" aria-label="提示词与风格">
    <header><h2>提示词与风格</h2><button className="text-button" onClick={onClose}>关闭提示词</button></header>
    <p className="muted">本地手动编辑，不会调用豆包或产生费用。真实生成尚未接入。修改会自动保存，请留意保存状态。</p>
    <div className="prompt-settings">
      <label>任务风格<select disabled={disabled} value={settings.style ?? "inherit"} onChange={event => onChange(updatePromptSettings(workspace, planStyle,
        { ...settings, style: event.target.value === "inherit" ? null : event.target.value as Plan["style"] }))}>
        <option value="inherit">继承周计划（{planStyleValue(planStyle) === "realistic" ? "偏真人" : "漫剧"}）</option>
        <option value="realistic">偏真人</option><option value="comic">漫剧</option>
      </select></label>
      <label>风格说明来源<select disabled={disabled} value={inheritsStyleNotes(workspace) ? "inherit" : "override"} onChange={event => onChange(updatePromptSettings(workspace, planStyle,
        { ...settings, notesMode: event.target.value as "inherit" | "override", notes: event.target.value === "override" ? effectiveStyleNotes(workspace, planStyle) : settings.notes }))}>
        <option value="inherit">继承计划说明</option><option value="override">独立覆盖说明（可留空）</option></select></label>
      <label>当前有效风格说明<textarea maxLength={5000} disabled={disabled || inheritsStyleNotes(workspace)} value={effectiveStyleNotes(workspace, planStyle)} onChange={event => onChange(
        updatePromptSettings(workspace, planStyle, { ...settings, notesMode: "override", notes: event.target.value }))} /></label>
      <p className="helper">旧非空任务说明保留为独立覆盖；旧空说明默认继承。风格类型与说明分别选择来源。说明变更会使相关提示词和图片确认需重新核对。</p>
    </div>
    <label>提示词类型<select value={valid ? selection : ""} disabled={disabled} onChange={event => setSelection(event.target.value)}>
      {!valid && <option value="">原镜头已删除，请重新选择</option>}
      {options.map(option => {
        const record = findPrompt(workspace, option.kind, option.shotId);
        const changed = record && record.inputSnapshot !== promptInput(workspace, planStyle, option.kind, option.shotId);
        return <option key={option.value} value={option.value}>{option.label}{changed ? " · 待更新" : record ? " · 已编辑" : " · 未填写"}</option>;
      })}
    </select></label>
    {valid && <>
      <p role="status">{current ? `手动编辑 · v${current.version}（保存后更新版本）` : "尚未填写"}{stale ? " · 输入已变化，旧文字保留，请核对" : ""}</p>
      <label>{PROMPT_LABELS[kind]}<textarea rows={7} maxLength={100000} disabled={disabled} value={current?.text ?? ""}
        onChange={event => onChange(editPrompt(workspace, planStyle, kind, shotId, event.target.value))} /></label>
      {stale && <button className="text-button" disabled={disabled} onClick={() => onChange(reviewPrompt(workspace, planStyle, kind, shotId))}>
        已核对当前输入，保留这项文字</button>}
      <PromptTemplatePreview key={`${taskId}:${kind}:${shotId ?? ""}`} taskId={taskId} savedRevision={savedRevision} saveState={saveState} onApplyTemplate={onApplyTemplate} workspace={workspace} planStyle={planStyle} kind={kind} shotId={shotId} disabled={disabled} />
      <details><summary>查看当前输入与依赖</summary><pre>{input}</pre></details>
      {stale && <details><summary>查看上次核对输入</summary><pre>{current.inputSnapshot}</pre></details>}
      <PromptHistory key={`${taskId}:${kind}:${shotId ?? ""}`} taskId={taskId} kind={kind} shotId={shotId} savedRevision={savedRevision} workspace={workspace} planStyle={planStyle} restoreDisabled={restoreDisabled} onChange={onChange} />
      {!workspace.shots.length && <p className="muted">尚无镜头，可先写草稿；添加镜头后会提示重新核对。</p>}
    </>}
  </section>;
}
