import { InspectionSummary } from "./InspectionSummary";
import type { SaveState } from "../../../shared/workspace-autosave";
import { imagePreview, type ImagePreviewState } from "../../../shared/image-preview-state";
import type { PlanStyleContext } from "../../../shared/prompts";
import { useEffect, useRef, useState } from "react";
import type { FrameCandidate, FrameSlot, FrameWorkspace, ReferenceImage, TaskWorkspace, VisualStyle } from "../../../shared/models";
import { addFrameCandidate, chooseFrame, confirmationIssue, currentFrame, frameState, hasCurrentConfirmation } from "../../../shared/frames";
import type { ReviewPromptKind } from "../../../shared/frames";
import { findPrompt, promptInput } from "../../../shared/prompts";
import { command } from "../api/client";
import "./FramePanel.css";

interface Props {
  workspace: TaskWorkspace;
  planStyle: PlanStyleContext;
  taskId: string;
  images: ReferenceImage[];
  busy: boolean;
  dirty: boolean;
  saveState: SaveState;
  savedRevision: number;
  onChange: (workspace: TaskWorkspace) => void;
  onBusy: (busy: boolean) => void;
  onImport: (image: ReferenceImage) => void;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  onEditPrompt: (kind: ReviewPromptKind) => void;
  focusSlot?: FrameSlot;
  imagePreviews: ImagePreviewState;
  onPreviewEvent: (id: string, epoch: number, status: "ready" | "failed") => void;
  onRefreshImages: (ids: string[]) => void;
}

const slotName = (slot: FrameSlot) => slot === "first" ? "首帧" : "尾帧";

export function FramePanel({ workspace, planStyle, taskId, images, busy, dirty, saveState, savedRevision, onChange, onBusy, onImport, onConfirm, onClose, onEditPrompt, focusSlot, imagePreviews, onPreviewEvent, onRefreshImages }: Props) {
  const slotRefs = useRef<Record<FrameSlot, HTMLElement | null>>({ first: null, last: null });
  useEffect(() => { if (focusSlot) { slotRefs.current[focusSlot]?.scrollIntoView({ block: "nearest" }); slotRefs.current[focusSlot]?.focus(); } }, [focusSlot]);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<FrameCandidate | null>(null);
  const lock = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const frames = frameState(workspace);
  const disabled = busy || operation !== null;
  const imageFor = (candidate: FrameCandidate | undefined) => candidate
    ? images.find(image => image.id === candidate.imageId && image.taskId === taskId) : undefined;
  const first = currentFrame(workspace, "first"), last = currentFrame(workspace, "last");
  const imagesReady = [first, last].every(candidate => !!imageFor(candidate) && !!candidate && imagePreview(imagePreviews, candidate.imageId).status === "ready");
  const issue = confirmationIssue(workspace, planStyle);
  const blocker = dirty ? "正在等待自动保存。保存完成后即可在此确认；保存失败时请返回画布重试。"
    : issue?.message
      ?? (!imagesReady ? "请等待两张当前图片加载成功；若文件不可读，请重新导入或选择其他候选。" : null);
  const confirmed = hasCurrentConfirmation(workspace, planStyle);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (expanded && dialog && !dialog.open) dialog.showModal();
    if (!expanded && dialog?.open) dialog.close();
  }, [expanded]);

  function changeFrames(next: FrameWorkspace) {
    if (disabled || lock.current) return;
    setError(null);
    onChange({ ...workspace, frames: { ...next,
      confirmation: next.confirmation ? { ...next.confirmation, invalidated: true } : null } });
  }

  async function importImage(slot: FrameSlot) {
    if (disabled || lock.current) return;
    if (frames.candidates.length >= 100) { setError("最多保留 100 个候选，请先移除不需要的候选。"); return; }
    const input = workspace;
    lock.current = true; setOperation(`正在导入${slotName(slot)}图片…`); onBusy(true); setError(null);
    try {
      const image = await command("assets.importReference", { taskId });
      if (image) {
        const next = addFrameCandidate(input, planStyle, slot, image.id, crypto.randomUUID(), new Date().toISOString(), !dirty);
        onImport(image);
        onChange(next);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "图片导入失败，原图片保持不变。"); }
    finally { lock.current = false; setOperation(null); onBusy(false); }
  }

  async function confirm() {
    if (disabled || lock.current || blocker) return;
    lock.current = true; setOperation("正在保存确认…"); setError(null);
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "确认失败，请重试。"); }
    finally { lock.current = false; setOperation(null); }
  }

  function choose(slot: FrameSlot, id: string | null) {
    if (disabled || lock.current) return;
    setError(null);
    try { onChange(chooseFrame(workspace, slot, id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法选择这张图片。"); }
  }

  function remove(candidate: FrameCandidate) {
    if (disabled || lock.current) return;
    const isCurrent = frames.firstId === candidate.id || frames.lastId === candidate.id;
    const next = isCurrent ? frameState(chooseFrame(workspace, candidate.slot, null)) : frames;
    // Removing an unused candidate does not invalidate the current review.
    onChange({ ...workspace, frames: { ...next, candidates: next.candidates.filter(item => item.id !== candidate.id) } });
    if (expanded?.id === candidate.id) setExpanded(null);
  }

  function preview(candidate: FrameCandidate, current: boolean) {
    const image = imageFor(candidate);
    if (!image) return <p role="status" className="inline-error">图片记录不可用，请重新导入。</p>;
    const { epoch, status } = imagePreview(imagePreviews, image.id);
    const failed = status === "failed";
    return <>
      <button className="frame-preview-button" disabled={disabled || failed} onClick={() => setExpanded(candidate)}
        aria-label={`放大${slotName(candidate.slot)}：${image.originalName}`}>
        <img key={`${candidate.id}-${epoch}`} src={`app://media/${image.id}?v=${epoch}`}
          alt={`${slotName(candidate.slot)}${current ? "当前图片" : "候选图片"}：${image.originalName}`}
          hidden={failed} onLoad={() => onPreviewEvent(image.id, epoch, "ready")}
          onError={() => onPreviewEvent(image.id, epoch, "failed")} />
      </button>
      {failed && <p className="inline-error" role="status">无法读取这张静态图片，请重新导入或选择其他候选。</p>}
      <small>{image.originalName} · {image.width} × {image.height}</small>
    </>;
  }

  return <section className="frame-panel" aria-label="首尾帧图片与审核">
    <header className="editor-heading"><h2>首尾帧图片与审核</h2>
      <button className="text-button" disabled={disabled} onClick={onClose}>返回画布</button></header>
    <p className="helper">分别导入两张静态图片，再选择为当前图片。导入只新增候选，不覆盖原图。真实免费生图与视频提交尚未接入。</p>
    {operation && <p role="status">{operation}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {frames.confirmation && (!confirmed || !imagesReady) && <p className="review-notice" role="status">
      {confirmed ? "确认记录已保存，但当前图片尚未通过可读检查。" : "素材或输入已更新，请核对并重新确认两张图片。"}</p>}
    {confirmed && imagesReady && !dirty && <p className="frame-confirmed" role="status">当前两张图片已确认 · {frames.confirmation?.confirmedAt}。仅保存本地审核，不会提交或排队生成视频。</p>}
    <div className="frame-columns">{(["first", "last"] as FrameSlot[]).map(slot => {
      const current = currentFrame(workspace, slot);
      const candidates = frames.candidates.filter(candidate => candidate.slot === slot);
      const kind = slot === "first" ? "firstFrame" : "lastFrame";
      const prompt = findPrompt(workspace, kind, null);
      return <article className="frame-column" key={slot} aria-label={`${slotName(slot)}图片`} tabIndex={-1} ref={element => { slotRefs.current[slot] = element; }}>
        <div className="editor-heading"><h3>{slotName(slot)} · {slot === "first" ? "开场画面" : "结束画面"}</h3>
          <button className="text-button" disabled={disabled || frames.candidates.length >= 100} onClick={() => { void importImage(slot); }}>导入{slotName(slot)}</button></div>
        {current ? <div className="frame-current">{preview(current, true)}
          <p className="helper">本地导入 · {current.createdAt} · 图片提示词版本 {current.promptVersion === null ? "未保存或未设置" : `v${current.promptVersion}`}</p>
          <button className="text-button" disabled={disabled} onClick={() => choose(slot, null)}>取消当前{slotName(slot)}选择</button>
        </div> : <p className="frame-empty">尚未选择{slotName(slot)}。导入后在候选中点击“设为当前{slotName(slot)}”。</p>}
        <details><summary>当前图片提示词</summary><p className="frame-text">{prompt?.text || "尚未填写，可编辑图片提示词。"}</p><button className="text-button" disabled={disabled} onClick={() => onEditPrompt(kind)}>编辑{slotName(slot)}提示词</button></details>
        <details open={!current}><summary>{slotName(slot)}候选（{candidates.length}）</summary>
          {candidates.map(candidate => <div className="frame-candidate" key={candidate.id}>
            {candidate.id !== current?.id && preview(candidate, false)}
            <p>{candidate.id === current?.id ? "当前图片 · " : ""}本地导入 · {candidate.createdAt}</p>
            <small>导入时图片提示词版本：{candidate.promptVersion === null ? "未保存或未设置" : `v${candidate.promptVersion}`}</small>
            {(candidate.inputSnapshot !== promptInput(workspace, planStyle, kind, null) || candidate.promptText !== (prompt?.text ?? ""))
              && <p className="review-notice">此候选来自较早的输入，请核对画面后再选择。</p>}
            <details><summary>导入时的提示词</summary><p className="frame-text">{candidate.promptText || "当时未填写图片提示词。"}</p></details>
            <div className="frame-actions"><button className="text-button" disabled={disabled || candidate.id === current?.id || !imageFor(candidate) || imagePreview(imagePreviews, candidate.imageId).status !== "ready"}
              onClick={() => choose(slot, candidate.id)}>设为当前{slotName(slot)}</button>
              <button className="text-button" disabled={disabled} onClick={() => remove(candidate)}>移除候选</button></div>
          </div>)}
          {candidates.length === 0 && <p className="helper">暂无候选。</p>}
        </details>
      </article>;
    })}</div>
    <p className="helper">移除候选只移除本任务候选记录，已归档图片文件保留。原文件改名或移动不会影响归档图片。</p>
    <button className="text-button" disabled={disabled} onClick={() => { onRefreshImages(frames.candidates.map(candidate => candidate.imageId)); }}>重新检查图片文件</button>
    <fieldset disabled={disabled} className="frame-parameters"><legend>本地视频参数草稿</legend>
      <label>画面比例<select aria-label="画面比例" value={frames.parameters.aspectRatio} onChange={event => changeFrames({ ...frames,
        parameters: { ...frames.parameters, aspectRatio: event.target.value as FrameWorkspace["parameters"]["aspectRatio"] } })}>
        <option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option><option value="1:1">方形 1:1</option></select></label>
      <label>目标时长<select aria-label="目标时长" value={frames.parameters.durationSeconds} onChange={event => changeFrames({ ...frames,
        parameters: { ...frames.parameters, durationSeconds: Number(event.target.value) as 5 | 10 } })}>
        <option value={5}>5 秒</option><option value={10}>10 秒</option></select></label>
      <p className="helper">这些仅是本地制作意向，不代表豆包免费入口支持。官方比例、时长和生成模式限制尚未验证，不能据此提交。</p>
    </fieldset>
    <details><summary>查看视频提示词</summary><p className="frame-text">{findPrompt(workspace, "video", null)?.text || "尚未填写视频提示词。"}</p><button className="text-button" disabled={disabled} onClick={() => onEditPrompt("video")}>编辑视频提示词</button></details>
    <InspectionSummary busy={disabled} workspace={workspace} planStyle={planStyle} taskId={taskId} savedRevision={savedRevision}
      saveState={saveState} images={images} imagePreviews={imagePreviews} />
    <footer className="frame-review-actions">
      {blocker && <p className="helper" role="status">{blocker}</p>}
      {!dirty && imagesReady && issue?.promptKind && <button className="text-button" disabled={disabled} onClick={() => onEditPrompt(issue.promptKind!)}>{issue.actionLabel}</button>}
      <button className="primary" disabled={disabled || !!blocker || (confirmed && imagesReady)} onClick={() => { void confirm(); }}>
        {confirmed && imagesReady && !dirty ? "当前版本已确认" : "确认这两张图片"}</button>
    </footer>
    <dialog ref={dialogRef} className="frame-lightbox" aria-label="静态图片放大预览" onCancel={() => setExpanded(null)} onClose={() => setExpanded(null)}>
      {expanded && <><div className="editor-heading"><h2>{slotName(expanded.slot)}图片</h2>
        <button autoFocus className="text-button" onClick={() => setExpanded(null)}>关闭放大预览</button></div>
        <img key={`${expanded.imageId}-${imagePreview(imagePreviews, expanded.imageId).epoch}`} src={`app://media/${expanded.imageId}?v=${imagePreview(imagePreviews, expanded.imageId).epoch}`} alt={`${slotName(expanded.slot)}放大预览`}
          onError={() => onPreviewEvent(expanded.imageId, imagePreview(imagePreviews, expanded.imageId).epoch, "failed")} />
        {imagePreview(imagePreviews, expanded.imageId).status === "failed" && <p role="alert">图片无法读取，请关闭后重新导入。</p>}</>}
    </dialog>
  </section>;
}
