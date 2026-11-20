import type { ApplySavedShotVideoDraft } from "../../../shared/saved-shot-video-draft";
import { ReferenceMappingPreview } from "./ReferenceMappingPreview";
import { SavedShotSummary } from "./SavedShotSummary";
import { captureTemporaryTemplateApply, type TemporaryTemplateApply } from "../../../shared/temporary-template-apply";
import { TemplateDraftSelection, type TemplateDraftSelectionContext } from "../../../shared/template-draft-selection";
import { emptyTemporaryTemplateEditor, prepareTemporaryTemplateEditor, editTemporaryTemplate, resetTemporaryTemplate, closeTemporaryTemplate, temporaryTemplateStale, captureTemporaryCopy, isCurrentTemporaryCopy } from "../../../shared/temporary-template-editor";
import type { InspectionSaveState } from "../../../shared/inspection-summary";
import { emptyTemplateSlotFields, updateTemplateSlotField, toPromptTemplateSlotFields, getSlotTemplateInputGaps } from "../../../shared/template-slot-fields";
import { emptyPreviewGlobalFields, updatePreviewGlobalField, getPreviewTemplateInputGaps, type PreviewGlobalFields } from "../../../shared/template-preview-fields";
import { useEffect, useRef, useState } from "react";
import type { PromptKind, TaskWorkspace } from "../../../shared/models";
import type { PlanStyleContext } from "../../../shared/prompts";
import { formatPromptTemplate } from "../../../shared/prompt-template";

/** Preview/edit/reset/copy are isolated; only the explicit apply action reaches normal autosave. */
type Props = {
  taskId: string; savedRevision: number; saveState: InspectionSaveState; onApplyTemplate: TemporaryTemplateApply; onApplyVideoDraft: ApplySavedShotVideoDraft;
  workspace: TaskWorkspace; planStyle: PlanStyleContext; kind: PromptKind; shotId: string | null; disabled: boolean;
};
export function PromptTemplatePreview(props: Props) {
  const endpoint = props.kind === "firstFrame" ? props.workspace.shots[0]?.id : props.kind === "lastFrame" ? props.workspace.shots.at(-1)?.id : props.shotId;
  return <ScopedTemplatePreview key={`${props.taskId}:${props.kind}:${endpoint ?? "none"}`} {...props} />;
}
function ScopedTemplatePreview({ workspace, planStyle, kind, shotId, disabled, taskId, savedRevision, saveState, onApplyTemplate, onApplyVideoDraft }: Props) {
  const [fields, setFields] = useState(emptyPreviewGlobalFields);
  const [fieldError, setFieldError] = useState("");
  const [slotFields, setSlotFields] = useState(() => kind !== "video" && workspace.shots.length ? emptyTemplateSlotFields(workspace, kind, shotId) : null);
  const slotValues = slotFields ? toPromptTemplateSlotFields(workspace, kind, shotId, slotFields) : {};
  const text = formatPromptTemplate(workspace, planStyle, kind, shotId, { ...fields, ...slotValues });
  const inputGaps = getPreviewTemplateInputGaps(workspace, kind, shotId, fields);
  const slotGaps = slotFields ? getSlotTemplateInputGaps(workspace, kind, shotId, slotFields).gaps : inputGaps.gaps;
  const remainingGaps = inputGaps.gaps.filter(gap => slotGaps.some(other => other.code === gap.code && other.scope === gap.scope && other.shotId === gap.shotId));
  const context: TemplateDraftSelectionContext | null = slotFields ? { taskId, revision: savedRevision, workspace, plan: planStyle, kind, shotId, globalFields: fields, slotFields, saveState: { dirty: saveState.dirty, saving: saveState.saving, error: saveState.error, conflict: saveState.conflict } } : null;
  const contextRef = useRef(context); contextRef.current = context;
  const applyRef = useRef(onApplyTemplate); applyRef.current = onApplyTemplate;
  const applyLock = useRef(false);
  const emptyTarget = !workspace.prompts?.some(prompt => prompt.kind === kind && prompt.shotId === shotId && prompt.text !== "");
  const eligible = context ? new TemplateDraftSelection(context).preview.status === "structural-preview" : false;
  const [editor, setEditor] = useState(emptyTemporaryTemplateEditor);
  const editorRef = useRef(editor); editorRef.current = editor;
  const [editorMessage, setEditorMessage] = useState("");
  const [editorCopying, setEditorCopying] = useState(false);
  const editorOperation = useRef(0), editorCopyLock = useRef(false);
  function updateEditor(next: typeof editor) { editorRef.current = next; setEditor(next); setEditorMessage(""); editorOperation.current++; editorCopyLock.current = false; setEditorCopying(false); }
  async function copyEditor() {
    if (disabled || editorCopyLock.current) return;
    const token = captureTemporaryCopy(editorRef.current); if (!token) return;
    const operation = ++editorOperation.current; editorCopyLock.current = true; setEditorCopying(true); setEditorMessage("");
    try { await navigator.clipboard.writeText(token.text);
      if (alive.current && editorOperation.current === operation && isCurrentTemporaryCopy(editorRef.current, token)) setEditorMessage("已复制临时文本；正式提示词未修改或保存。");
    } catch {
      if (alive.current && editorOperation.current === operation && isCurrentTemporaryCopy(editorRef.current, token)) setEditorMessage("复制失败，请在临时编辑区手动选择并复制。");
    } finally { if (alive.current && editorOperation.current === operation) { editorCopyLock.current = false; setEditorCopying(false); } }
  }
  const latest = useRef(text); latest.current = text;
  const alive = useRef(true), copying = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; message: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function copy() {
    if (disabled || copying.current) return;
    const captured = text; copying.current = true; setBusy(true); setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(captured);
      if (alive.current && latest.current === captured) setFeedback({ text: captured, message: "已复制当前格式预览；原提示词未改动。" });
    } catch {
      if (alive.current && latest.current === captured) setFeedback({ text: captured, message: "无法自动复制，请在下方预览中手动选择并复制。" });
    } finally {
      copying.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return <details className="prompt-template-preview">
    <summary>固定格式预览（只读，不替换原文）</summary>
    <p className="helper">只整理当前镜头、风格和关联资产，不改写已编辑提示词，也不调用模型。未填写项需自行补充；不会猜测镜头时长、设备、光线或人物位置。预览可能包含尚未保存的编辑。</p>
    <fieldset disabled={disabled || busy}><legend>临时补充全片字段（仅此预览）</legend>
      <p className="helper">只使用你输入的文字，不自动推断。每项最多 2000 字符。同一预览内保留输入；收起本预览不会清空，关闭提示词面板、切换任务或提示词位置会清空。不保存到项目，也不改写正式提示词。</p>
      {([["tone", "影片基调"], ["lighting", "光线设计"], ["colorAnchor", "色彩锚点"]] as const).map(([key, label]) =>
        <label key={key}>{label}<textarea rows={2} maxLength={2000} value={fields[key]} onChange={event => {
          const value = event.target.value;
          try { const next = updatePreviewGlobalField(fields, key as keyof PreviewGlobalFields, value); setFields(next); setFieldError(""); }
          catch { setFieldError("字段无效或超过 2000 字符，原输入保留。"); }
        }} /></label>)}
      <button type="button" className="text-button" onClick={() => { setFields(emptyPreviewGlobalFields()); setFieldError(""); }}>清空临时字段</button>
      {fieldError && <p role="alert">{fieldError}</p>}
    </fieldset>
    {slotFields && <fieldset disabled={disabled || busy}><legend>{kind === "shot" ? "当前镜头临时字段" : kind === "firstFrame" ? "首帧静态临时字段" : "尾帧静态临时字段"}</legend>
      <p className="helper">只用于当前镜头或端点，每项最多 2000 字符。时长按原文保留，不自动计算；静态状态不从动作推断。端点镜头改变也会清空临时输入。</p>
      {(kind === "shot" ? [["duration", "时长或时间说明"], ["continuity", "连续性约束"]] : [["composition", "静态构图"], ["state", kind === "firstFrame" ? "起始静态状态" : "结束静态状态"]]).map(([key, label]) =>
        <label key={key}>{label}<textarea rows={2} maxLength={2000} value={(slotFields.values as unknown as Record<string, string>)[key!] ?? ""} onChange={event => {
          try { setSlotFields(updateTemplateSlotField(slotFields, key!, event.target.value)); setFieldError(""); }
          catch { setFieldError("字段无效或超过 2000 字符，原输入保留。"); }
        }} /></label>)}
      <button type="button" className="text-button" onClick={() => { setSlotFields(emptyTemplateSlotFields(workspace, kind, shotId)); setFieldError(""); }}>清空当前位置临时字段</button>
    </fieldset>}
    {kind === "video" && <p className="helper">整条视频预览暂不汇集其他位置的临时字段；请在对应镜头预览填写，复制后自行整理。</p>}
    <p className="helper">当前预览仍需人工核对，不能把“未提供”当作完成内容。只有满足条件并明确点击“写入空白提示词（将自动保存）”才写入正式草稿。仍需补充的结构化字段或对应关系：{[...new Set(remainingGaps.filter(gap => gap.category === "field-unavailable").map(gap => gap.label.split("：")[0]))].join("、") || "当前列项均有临时输入，仍需人工核对"}。这些是本地模板缺项，不是已验证的提供方必填规则。可复制后在原提示词编辑区自行完善；临时字段不会自动写入该编辑区。</p>
    <button type="button" className="text-button" disabled={disabled || busy || !text} onClick={() => { void copy(); }}>{busy ? "正在复制…" : "复制格式预览"}</button>
    {feedback?.text === text && <p role="status">{feedback.message}</p>}
    <p className="helper">临时编辑区独立于项目：输入、恢复原文和复制不会保存；只有明确点击“写入空白提示词（将自动保存）”才修改正式草稿，仍不会确认素材。关闭、切换任务／提示词位置／首尾端点会丢弃临时文本，请先复制留存。</p>
    {kind !== "video" && emptyTarget && <button type="button" className="text-button" disabled={disabled || !!editor.buffer || !eligible} onClick={() => {
      if (!context || editorRef.current.buffer) return;
      try { updateEditor(prepareTemporaryTemplateEditor(editorRef.current, context)); } catch { setEditorMessage("无法准备临时文本，请检查保存状态、空白目标和临时字段。"); }
    }}>在临时编辑区准备</button>}
    {!eligible && !editor.buffer && <p className="helper">仅支持已保存、正文严格为空的镜头或首尾帧位置；须补齐临时结构化字段及对应关系。不支持整条视频，不代表生成能力已验证。</p>}
    {editor.buffer && <fieldset><legend>独立临时编辑区（明确写入前不保存）</legend>
      {temporaryTemplateStale(editor, context) && <p role="status">来源已变化，当前临时文本保留不覆盖；请人工核对，或关闭后重新准备。</p>}
      <label>临时文本<textarea rows={12} maxLength={100000} value={editor.buffer.text} onChange={event => {
        try { updateEditor(editTemporaryTemplate(editorRef.current, event.target.value)); } catch { setEditorMessage("临时文本最多 100000 字符，原内容保留。"); }
      }} /></label>
      <p className="helper">下一按钮会把当前临时文本写入空白正式提示词并进入正常自动保存；保存失败仍保留正式草稿，请查看画布保存状态。</p>
      <button type="button" className="text-button" disabled={disabled || !eligible || temporaryTemplateStale(editor, context) || !editor.buffer.text.trim()} onClick={() => {
        if (applyLock.current || disabled || !contextRef.current || !editorRef.current.buffer) return;
        applyLock.current = true;
        try {
          const envelope = captureTemporaryTemplateApply(editorRef.current);
          if (!applyRef.current(envelope, contextRef.current, editorRef.current)) { setEditorMessage("来源或保存状态已变化，未写入；临时文本保留，请核对。"); return; }
          updateEditor(closeTemporaryTemplate(editorRef.current));
          setEditorMessage("已写入正式草稿并交给自动保存；请查看画布保存结果，尚不代表保存成功。");
        } catch { setEditorMessage("未能写入，临时文本保留，请核对当前状态。"); }
        finally { applyLock.current = false; }
      }}>写入空白提示词（将自动保存）</button>
      <button type="button" className="text-button" onClick={() => updateEditor(resetTemporaryTemplate(editorRef.current))}>恢复本次准备原文（丢弃临时修改）</button>
      <button type="button" className="text-button" disabled={disabled || editorCopying} onClick={() => { void copyEditor(); }}>{editorCopying ? "正在复制…" : "复制临时文本"}</button>
      <button type="button" className="text-button" onClick={() => updateEditor(closeTemporaryTemplate(editorRef.current))}>关闭并丢弃临时文本</button>
    </fieldset>}
    {editorMessage && <p role="status">{editorMessage}</p>}
    <label>格式预览文本<textarea readOnly rows={12} value={text} /></label>
    <ReferenceMappingPreview context={{ taskId, revision: savedRevision, workspace, plan: planStyle, kind, shotId, templateText: text }} disabled={disabled} />
    {kind === "video" && <SavedShotSummary key={taskId} taskId={taskId} workspace={workspace} planStyle={planStyle} savedRevision={savedRevision} saveState={saveState} disabled={disabled} onApplyVideoDraft={onApplyVideoDraft} />}
  </details>;
}
