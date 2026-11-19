import type { ScriptReusePreview } from "../../../shared/script-reuse-draft";
import { useEffect, useRef, useState } from "react";
import type { ScriptHistoryDetail, ScriptHistorySummary } from "../../../shared/models";
import { HistoryReads } from "../../../shared/latest-read";
import { command } from "../api/client";

export function ScriptHistory({ taskId, savedRevision, reuseDisabled, onReuse }: { taskId: string; savedRevision: number; reuseDisabled: boolean; onReuse: (preview: ScriptReusePreview, current: () => boolean) => Promise<boolean> }) {
  const [reusePreview, setReusePreview] = useState<ScriptReusePreview | null>(null);
  const [reuseBusy, setReuseBusy] = useState(false), [reuseMessage, setReuseMessage] = useState("");
  const reuseOperation = useRef(0), reuseLock = useRef(false);
  const live = useRef({ taskId, savedRevision, reuseDisabled }); live.current = { taskId, savedRevision, reuseDisabled };
  function cancelReuse() { reuseOperation.current++; reuseLock.current = false; setReuseBusy(false); setReusePreview(null); setReuseMessage(""); }
  useEffect(() => { cancelReuse(); return () => { reuseOperation.current++; }; }, [taskId, savedRevision]);
  async function previewReuse(version: number) {
    if (live.current.reuseDisabled || reuseLock.current) return;
    const operation = ++reuseOperation.current; reuseLock.current = true; setReuseBusy(true); setReuseMessage("");
    try { const preview = await command("scripts.previewReuse", { taskId, expectedRevision: savedRevision, version });
      if (operation === reuseOperation.current && !live.current.reuseDisabled && live.current.taskId === taskId && live.current.savedRevision === savedRevision) setReusePreview(preview);
    } catch { if (operation === reuseOperation.current) setReuseMessage("无法预览，请确认当前编辑已保存后重试。"); }
    finally { if (operation === reuseOperation.current) { reuseLock.current = false; setReuseBusy(false); } }
  }
  async function applyReuse() {
    if (!reusePreview || live.current.reuseDisabled || reuseLock.current) return;
    const operation = ++reuseOperation.current; reuseLock.current = true; setReuseBusy(true);
    const current = () => operation === reuseOperation.current && live.current.taskId === reusePreview.taskId && live.current.savedRevision === reusePreview.revision && !live.current.reuseDisabled;
    try { const accepted = await onReuse(reusePreview, current);
      if (operation === reuseOperation.current) { setReusePreview(null); setReuseMessage(accepted ? reusePreview.changed ? "已复用为新草稿并交给自动保存，请查看保存结果。" : "正文相同，未产生新修改或历史。" : "当前编辑已变化，未覆盖草稿；请重新预览。"); }
    } catch { if (operation === reuseOperation.current) { setReusePreview(null); setReuseMessage("复用未完成，当前草稿保留，请重新预览。"); } }
    finally { if (operation === reuseOperation.current) { reuseLock.current = false; setReuseBusy(false); } }
  }
  const [open, setOpen] = useState(false);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false);
  const busy = listBusy || detailBusy;
  const [items, setItems] = useState<ScriptHistorySummary[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [detail, setDetail] = useState<ScriptHistoryDetail | null>(null);
  const [error, setError] = useState("");
  const requests = useRef(new HistoryReads());
  async function load(cursor?: number) {
    const token = requests.current.list.begin(); setListBusy(true); setError("");
    try {
      const result = await command("scripts.historyList", { taskId, beforeVersion: cursor, limit: 20 });
      if (!requests.current.list.current(token)) return;
      setItems(previous => cursor ? [...previous, ...result.items] : result.items); setBefore(result.nextBeforeVersion);
    } catch (cause) { if (requests.current.list.current(token)) setError(cause instanceof Error ? cause.message : "读取剧本历史失败。"); }
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
    cancelReuse();
    const token = requests.current.detail.begin(); setDetailBusy(true); setDetail(null); setError("");
    try {
      const value = await command("scripts.historyDetail", { taskId, version });
      if (requests.current.detail.current(token)) setDetail(value);
    } catch (cause) { if (requests.current.detail.current(token)) setError(cause instanceof Error ? cause.message : "读取剧本版本失败。"); }
    finally { if (requests.current.detail.current(token)) setDetailBusy(false); }
  }
  return <section className="prompt-history" aria-label="剧本历史版本">
    <button className="text-button" aria-expanded={open} onClick={() => { cancelReuse(); setOpen(value => !value); }}>{open ? "收起剧本历史" : "查看已保存剧本历史"}</button>
    {open && <>
      <p className="helper">只记录保存成功的正文变化，包括清空。升级时只能记录当时已有正文（可能为空）作为基线，时间是首次记录时间，不代表原始创作时间。新任务空稿尚无编辑历史。历史原文只读。可先预览，再明确复用为新草稿进入自动保存；旧历史不会覆盖，不调用模型。</p>
      <button className="text-button" disabled={busy} onClick={() => void load()}>刷新剧本历史</button>
      {error && <p role="alert">{error}<button className="text-button" disabled={busy} onClick={() => void load()}>重试列表</button></p>}
      {!busy && !items.length && !error && <p>尚无已保存剧本历史，编辑并保存正文后可查看。</p>}
      {items.map(item => <p key={item.version}><button className="text-button" disabled={busy} onClick={() => void select(item.version)}>v{item.version} · {item.recordType === "baseline" ? "已有正文基线，首次记录" : "保存时间"} {new Date(item.recordedAt).toLocaleString()} · {item.textLength} 字</button></p>)}
      {busy && <p role="status">正在读取剧本历史…</p>}
      {before && <button className="text-button" disabled={busy} onClick={() => void load(before)}>加载更早剧本版本</button>}
      {detail && <article aria-label={`剧本历史版本 ${detail.version}`}><h3>剧本 v{detail.version}（只读）</h3>
        <p>{detail.recordType === "baseline" ? "已有正文基线，首次记录时间" : "保存时间"}：{new Date(detail.recordedAt).toLocaleString()}</p>
        {detail.text === "" && <p>此版本正文为空。</p>}
        <label>历史剧本正文<textarea readOnly rows={8} value={detail.text} /></label>
        <button className="text-button" disabled={reuseDisabled || reuseBusy || busy} onClick={() => { void previewReuse(detail.version); }}>预览复用这个版本</button>
      </article>}
      {reusePreview && <article aria-label="复用剧本预览"><h3>复用为新草稿前核对</h3>
        <p className="helper">下一按钮将替换当前剧本正文并进入正常自动保存，镜头及资产会标记待核对，已有图片确认可能失效。旧历史和其他制作内容保留。取消不修改。</p>
        {reusePreview.history.text === "" && <p role="alert">此历史正文为空。确认复用会清空当前剧本正文。</p>}
        <label>当前已保存正文<textarea readOnly rows={6} value={reusePreview.currentText} /></label>
        <label>将复用的历史正文<textarea readOnly rows={6} value={reusePreview.history.text} /></label>
        <button className="text-button" disabled={reuseDisabled || reuseBusy} onClick={() => { void applyReuse(); }}>复用为新草稿（将自动保存）</button>
        <button className="text-button" onClick={cancelReuse}>取消复用</button>
      </article>}
      {reuseMessage && <p role="status">{reuseMessage}</p>}
    </>}
  </section>;
}
