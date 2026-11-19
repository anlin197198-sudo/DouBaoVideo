import { useEffect, useRef, useState } from "react";
import type { PromptHistoryDetail, PromptHistorySummary, PromptKind } from "../../../shared/models";
import { HistoryReads } from "../../../shared/latest-read";
import { command } from "../api/client";

export function PromptHistory({ taskId, kind, shotId, savedRevision }: { taskId: string; kind: PromptKind; shotId: string | null; savedRevision: number }) {
  const [open, setOpen] = useState(false);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false);
  const busy = listBusy || detailBusy;
  const [items, setItems] = useState<PromptHistorySummary[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [detail, setDetail] = useState<PromptHistoryDetail | null>(null);
  const [error, setError] = useState("");
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
    const token = requests.current.detail.begin(); setDetailBusy(true); setDetail(null); setError("");
    try {
      const value = await command("prompts.historyDetail", { taskId, kind, shotId, version });
      if (requests.current.detail.current(token)) setDetail(value);
    } catch (cause) { if (requests.current.detail.current(token)) setError(cause instanceof Error ? cause.message : "读取版本失败。"); }
    finally { if (requests.current.detail.current(token)) setDetailBusy(false); }
  }
  return <section className="prompt-history" aria-label="提示词历史版本">
    <button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起历史版本" : "查看已保存历史版本（只读）"}</button>
    {open && <>
      <p className="helper">只记录已保存版本。启用历史前仅保留当时当前版本作为基线，不代表更早编辑历史；基线时间是首次记录时间。这里只回看，不恢复、不覆盖当前草稿。</p>
      <button className="text-button" disabled={busy} onClick={() => void load()}>刷新已保存历史</button>
      {error && <p role="alert">{error}<button className="text-button" disabled={busy} onClick={() => void load()}>重新读取列表</button></p>}
      {!busy && !items.length && !error && <p>尚无已保存历史，保存提示词后可查看。</p>}
      {items.map(item => <p key={item.version}><button className="text-button" disabled={busy} onClick={() => void select(item.version)}>v{item.version} · {item.recordType === "baseline" ? "已有版本基线，首次记录" : "保存时间"} {new Date(item.recordedAt).toLocaleString()} · {item.textLength} 字</button></p>)}
      {busy && <p role="status">正在读取历史…</p>}
      {before && <button className="text-button" disabled={busy} onClick={() => void load(before)}>加载更早版本</button>}
      {detail && <article aria-label={`历史版本 ${detail.version}`}><h3>v{detail.version}（只读）</h3>
        <p>{detail.recordType === "baseline" ? "启用历史时的已有版本基线，首次记录时间" : "保存时间"}：{new Date(detail.recordedAt).toLocaleString()}</p>
        <label>历史正文<textarea readOnly rows={6} value={detail.text} /></label>
        <details><summary>当时的输入快照</summary><pre>{detail.inputSnapshot}</pre></details>
      </article>}
    </>}
  </section>;
}
