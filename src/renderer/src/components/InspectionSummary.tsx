import { useEffect, useRef, useState } from "react";
import { InspectionCopy } from "../../../shared/inspection-copy";
import { buildInspectionSummary } from "../../../shared/inspection-summary";
import type { ImagePreviewState } from "../../../shared/image-preview-state";
import type { ReferenceImage, TaskWorkspace } from "../../../shared/models";
import type { PlanStyleContext } from "../../../shared/prompts";
import type { SaveState } from "../../../shared/workspace-autosave";

export function InspectionSummary({ workspace, planStyle, taskId, savedRevision, saveState, images, imagePreviews, busy = false }: {
  workspace: TaskWorkspace; planStyle: PlanStyleContext; taskId: string; savedRevision: number;
  saveState: SaveState; busy?: boolean; images: ReferenceImage[]; imagePreviews: ImagePreviewState;
}) {
  const summary = buildInspectionSummary(workspace, planStyle, taskId, savedRevision, saveState, images, imagePreviews);
  const copyState = useRef(new InspectionCopy());
  const eligible = copyState.current.observe(summary, imagePreviews, busy);
  const [copying, setCopying] = useState(false);
  const [feedback, setFeedback] = useState<{key:string; message:string} | null>(null);
  const key = JSON.stringify({summary,imagePreviews,busy});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; copyState.current.cancel(); }; }, []);
  useEffect(() => { setCopying(false); setFeedback(null); }, [key]);
  async function copy() {
    const token = copyState.current.begin(); if (!token) return;
    setCopying(true); setFeedback(null);
    let message = "已复制已保存视频提示词原文；未提交、未排队，也未复制图片。";
    try { await navigator.clipboard.writeText(token.text); }
    catch { message = "复制失败，未提交；请重试或在上方只读正文手动选择。"; }
    if (alive.current && copyState.current.finish(token)) { setCopying(false); setFeedback({key,message}); }
  }

  return <section className="inspection-summary" aria-label="出片前检查（不提交）">
    <h3>出片前检查 / 不提交</h3>
    <p className="helper">只读本地状态，不运行提供方预检，不提交、不排队。以下不是可发送凭证。</p>
    {summary.status === "hidden-unsaved" ? <p role="status">有未保存内容、保存操作或冲突尚未解决。已保存输入详情暂不展示，请先完成保存；当前草稿保持不变。</p>
      : <>
        <p>已保存任务修订 r{summary.saved.revision} · {summary.saved.confirmation.coherent ? "本地确认与当前输入一致" : "尚无当前有效本地确认"}</p>
        {summary.saved.confirmation.confirmedAt && <p className="helper">记录确认时间：{summary.saved.confirmation.confirmedAt}</p>}
        {summary.saved.confirmation.issue && <p role="status">{summary.saved.confirmation.issue}</p>}
        <ul>{summary.saved.frames.map(frame => <li key={frame.role}>
          <strong>{frame.role === "first" ? "首帧" : "尾帧"}</strong>：
          {frame.candidateId ? <>候选 {frame.candidateId} · 图片 {frame.imageId}
            {frame.width !== null && frame.height !== null && <> · {frame.width} × {frame.height}</>}</> : "尚未选择"}
          <br />预览：{{ missing: "未选择", "metadata-unavailable": "本任务图片记录不可用", pending: "等待加载", ready: "已加载（不代表发送校验通过）", failed: "读取失败" }[frame.previewStatus]}
        </li>)}</ul>
        <details><summary>已保存视频提示词{summary.saved.video ? ` v${summary.saved.video.version}` : "（尚未填写）"}</summary>
          <p className="frame-text">{summary.saved.video?.text || "尚未填写。"}</p>
        </details>
      </>}
    <button type="button" className="text-button" disabled={!eligible || copying} onClick={() => { void copy(); }}>{copying ? "正在复制…" : "仅复制已保存视频提示词（不提交）"}</button>
    <p className="helper">仅在保存完成、本地确认有效且两张当前图片预览已加载时可复制，供人工核对；不是提供方校验或发送授权。</p>
    {feedback?.key === key && <p role="status">{feedback.message}</p>}
    <p className="helper">图片身份来自本地记录，未展示磁盘路径。媒体摘要未暴露到本页面，发送前仍需主进程重新校验，不能以预览加载成功代替。</p>
    <ul className="helper">
      <li>账号登录、免费状态与目标入口能力：未验证。</li>
      <li>首尾模式、角色、比例及数量限制：未验证。</li>
      <li>附加素材：未建立产品级明确选取与确认，不从关联资产自动采用。</li>
      <li>真实视频提交及队列：未接入。</li>
    </ul>
  </section>;
}
