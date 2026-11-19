import { useEffect, useRef, useState } from "react";
import type { TaskWorkspace, VideoTask } from "../../../shared/models";
import { Modal } from "./Modal";

function summary(workspace: TaskWorkspace) {
  return `剧本 ${workspace.script.length} 字 · ${workspace.shots.length} 个镜头 · ${workspace.assets.length} 项资产 · ${workspace.assetLinks.length} 条引用 · ${workspace.prompts?.length ?? 0} 项提示词 · ${workspace.frames?.candidates.length ?? 0} 张候选图`;
}

export function SaveConflictDialog({ local, localRevision, onReadLatest, onResolve, onClose }: {
  local: TaskWorkspace; localRevision: number;
  onReadLatest: () => Promise<VideoTask>;
  onResolve: (latest: VideoTask, choice: "overwrite" | "discard") => Promise<boolean>;
  onClose: () => void;
}) {
  const [latest, setLatest] = useState<VideoTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [choice, setChoice] = useState<"overwrite" | "discard" | null>(null);
  const lock = useRef(false), active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  async function read() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setChoice(null); setMessage(null);
    try { const task = await onReadLatest(); if (active.current) setLatest(task); }
    catch (error) { if (active.current) { setLatest(null); setMessage(error instanceof Error ? error.message : "读取失败，请重试。"); } }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function resolve() {
    if (lock.current || !latest || !choice) return;
    lock.current = true; setBusy(true); setMessage(null);
    try {
      const success = await onResolve(latest, choice);
      if (success) { onClose(); return; }
      setLatest(null); setChoice(null); setMessage("操作未完成，草稿仍保留。若已保存版本再次变化，请重新读取；其他保存错误请关闭弹窗查看原因并重试。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败，草稿仍保留。"); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const labels = { script: "剧本", shots: "镜头", assets: "资产", assetLinks: "关联", prompts: "提示词", promptSettings: "风格", frames: "图片与确认", viewport: "视图", scriptPosition: "剧本位置", productionPositions: "制作节点位置" };
  const changed = latest ? (Object.keys(labels) as (keyof typeof labels)[]).filter(key => JSON.stringify(local[key]) !== JSON.stringify(latest.workspace[key])) : [];
  return <Modal title="保存版本冲突：选择如何处理草稿" busy={busy} onClose={onClose}>
    <p>另一处修改已先保存。自动保存已暂停，不会自动覆盖。关闭此弹窗可继续保留和编辑本地草稿。</p>
    <h3>我的本地草稿（保存所用修订 {localRevision}）</h3><p>{summary(local)}</p>
    <details><summary>查看并复制完整本地草稿 JSON</summary>
      <textarea aria-label="完整本地草稿 JSON" readOnly rows={9} style={{ width: "100%" }} value={JSON.stringify(local, null, 2)} onFocus={event => event.currentTarget.select()} />
      <p className="helper">点入文本框后 Ctrl+C 复制，可另存到本地。此操作不会上传或分享。</p></details>
    <button className="text-button" disabled={busy} onClick={() => { void read(); }}>{busy ? "处理中…" : "读取最新已保存版本"}</button>
    {latest && <>
      <h3>已保存版本（修订 {latest.revision}）</h3><p>{summary(latest.workspace)}</p><p>最后保存：{latest.updatedAt}</p>
      <p>不同部分：{changed.length ? changed.map(key => labels[key]).join("、") : "内容相同，仅修订号不同"}</p>
      <details><summary>查看完整已保存版本 JSON</summary><textarea aria-label="完整已保存版本 JSON" readOnly rows={9} style={{ width: "100%" }} value={JSON.stringify(latest.workspace, null, 2)} onFocus={event => event.currentTarget.select()} /></details>
      <div className="canvas-tools" style={{ marginTop: 16 }}>
        <button className="text-button" disabled={busy} onClick={() => setChoice("overwrite")}>保留我的草稿并覆盖已保存版本</button>
        <button className="text-button danger" disabled={busy} onClick={() => setChoice("discard")}>使用已保存版本，放弃此草稿</button>
      </div>
      {choice && <div className="review-notice" role="alert">
        <p>{choice === "overwrite" ? `将用当前本地草稿覆盖上方修订 ${latest.revision} 的已保存内容。此操作不合并，可能移除另一处新增的内容；若版本再次变化会拒绝保存。`
          : "将放弃当前未保存草稿，改用上方已保存内容。请先复制需要保留的草稿；此操作不会删除归档图片文件。"}</p>
        <button className="primary" disabled={busy} onClick={() => { void resolve(); }}>{choice === "overwrite" ? "确认覆盖这个已保存版本" : "确认放弃本地草稿"}</button>
        <button className="text-button" disabled={busy} onClick={() => setChoice(null)}>取消选择</button>
      </div>}
    </>}
    {message && <p role="alert" className="inline-error">{message}</p>}
  </Modal>;
}
