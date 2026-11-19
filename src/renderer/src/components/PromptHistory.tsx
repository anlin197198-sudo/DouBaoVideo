import { useEffect, useRef, useState } from "react";
import type { PromptHistoryDetail, PromptHistorySummary, PromptKind, TaskWorkspace } from "../../../shared/models";
import type { PlanStyleContext } from "../../../shared/prompts";
import { previewPromptRestore, applyPromptRestore } from "../../../shared/prompt-restore";
import { HistoryReads } from "../../../shared/latest-read";
import { command } from "../api/client";

export function PromptHistory({ taskId, kind, shotId, savedRevision, workspace, planStyle, restoreDisabled, onChange }: { taskId: string; kind: PromptKind; shotId: string | null; savedRevision: number; workspace: TaskWorkspace; planStyle: PlanStyleContext; restoreDisabled: boolean; onChange: (next: TaskWorkspace) => void }) {
  const [open, setOpen] = useState(false);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false);
  const busy = listBusy || detailBusy;
  const [items, setItems] = useState<PromptHistorySummary[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [detail, setDetail] = useState<PromptHistoryDetail | null>(null);
  const [error, setError] = useState("");
  const [restorePreview, setRestorePreview] = useState<ReturnType<typeof previewPromptRestore> | null>(null);
  const [notice, setNotice] = useState("");
  const consumed = useRef(false);
  const requests = useRef(new HistoryReads());
  async function load(cursor?: number) {
    const token = requests.current.list.begin(); setListBusy(true); setError("");
    try {
      const result = await command("prompts.historyList", { taskId, kind, shotId, beforeVersion: cursor, limit: 20 });
      if (!requests.current.list.current(token)) return;
      setItems(previous => cursor ? [...previous, ...result.items] : result.items); setBefore(result.nextBeforeVersion);
    } catch (cause) { if (requests.current.list.current(token)) setError(cause instanceof Error ? cause.message : "读取历史失败。"); }
    finally { if (requests.current.list.current(token)) setListBusy(false); }
  }
  useEffect(() => {
    if (open) { setItems([]); setBefore(null); void load(); }
    return () => requests.current.list.cancel();
  }, [open, savedRevision]);
  useEffect(() => {
    if (!open) { setListBusy(false); setDetailBusy(false); }
    return () => requests.current.cancel();
  }, [open]);
  async function select(version: number) {
    setRestorePreview(null); setNotice(""); consumed.current = true;
    const token = requests.current.detail.begin(); setDetailBusy(true); setDetail(null); setError("");
    try {
      const value = await command("prompts.historyDetail", { taskId, kind, shotId, version });
      if (requests.current.detail.current(token)) setDetail(value);
    } catch (cause) { if (requests.current.detail.current(token)) setError(cause instanceof Error ? cause.message : "读取版本失败。"); }
    finally { if (requests.current.detail.current(token)) setDetailBusy(false); }
  }
  function previewRestore() {
    if (!detail || restoreDisabled || busy) return;
    try {
      const preview = previewPromptRestore(workspace, planStyle, kind, shotId, detail);
      consumed.current = false; setError(""); setNotice("");
      if (!preview.changed) { setRestorePreview(null); setNotice("当前正文与输入快照已是该版本，无需恢复，也不会重复生成版本。"); }
      else setRestorePreview(preview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法预览历史恢复。"); }
  }
  function confirmRestore() {
    if (!restorePreview || restoreDisabled || busy || consumed.current) return;
    consumed.current = true;
    try {
      onChange(applyPromptRestore(workspace, planStyle, restorePreview));
      setRestorePreview(null);
      setNotice("已放入当前编辑，等待自动保存为新版本；请查看画布保存状态。旧历史版本保留，输入若过期仍需逐项核对。");
    } catch (cause) { setRestorePreview(null); setError(cause instanceof Error ? cause.message : "内容已变化，请重新预览。"); }
  }
  return <section className="prompt-history" aria-label="提示词历史版本">
    <button className="text-button" aria-expanded={open} onClick={() => { consumed.current = true; setRestorePreview(null); setNotice(""); setOpen(value => !value); }}>{open ? "收起历史版本" : "查看已保存历史版本"}</button>
    {open && <>
      <p className="helper">只记录已保存版本。启用历史前仅保留当时当前版本作为基线，不代表更早编辑历史；基线时间是首次记录时间。历史记录本身只读。当前编辑保存完毕后，可明确确认将历史正文作为新版本使用；不自动核对旧输入，不覆盖历史。</p>
      <button className="text-button" disabled={busy} onClick={() => void load()}>刷新已保存历史</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}<button className="text-button" disabled={busy} onClick={() => void load()}>重新读取列表</button></p>}
      {!busy && !items.length && !error && <p>尚无已保存历史，保存提示词后可查看。</p>}
      {items.map(item => <p key={item.version}><button className="text-button" disabled={busy} onClick={() => void select(item.version)}>v{item.version} · {item.recordType === "baseline" ? "已有版本基线，首次记录" : "保存时间"} {new Date(item.recordedAt).toLocaleString()} · {item.textLength} 字</button></p>)}
      {busy && <p role="status">正在读取历史…</p>}
      {before && <button className="text-button" disabled={busy} onClick={() => void load(before)}>加载更早版本</button>}
      {detail && <article aria-label={`历史版本 ${detail.version}`}><h3>v{detail.version}（只读）</h3>
        <p>{detail.recordType === "baseline" ? "启用历史时的已有版本基线，首次记录时间" : "保存时间"}：{new Date(detail.recordedAt).toLocaleString()}</p>
        <label>历史正文<textarea readOnly rows={6} value={detail.text} /></label>
        <details><summary>当时的输入快照</summary><pre>{detail.inputSnapshot}</pre></details>
        <button className="text-button" disabled={busy || restoreDisabled} onClick={previewRestore}>预览使用此历史版本</button>
        {restoreDisabled && <p className="helper">先等待当前编辑保存成功并解决冲突，再使用历史版本，以免丢失未保存内容。</p>}
        {restorePreview && <div role="alert">
          <p>将 v{restorePreview.historyVersion} 的正文和当时输入快照用于当前这一项提示词？当前已保存版本与其他历史均保留；其他提示词正文不变，但相关下游可能需重新核对。不会自动确认图片。</p>
          <button className="text-button" disabled={busy || restoreDisabled} onClick={confirmRestore}>确认使用，保存为新版本</button>
          <button className="text-button" onClick={() => { consumed.current = true; setRestorePreview(null); }}>取消</button>
        </div>}
      </article>}
    </>}
  </section>;
}
