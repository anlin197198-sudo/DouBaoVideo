import { useEffect, useRef, useState } from "react";
import { ReferenceMappingSession, type ReferenceMappingContext } from "../../../shared/reference-mapping";

/** Intentionally isolated from template selection, gap readiness and normal autosave. */
export function ReferenceMappingPreview({ context, disabled }: { context: ReferenceMappingContext; disabled: boolean }) {
  const [session, setSession] = useState(() => new ReferenceMappingSession(context));
  const [, render] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(0), alive = useRef(true), lock = useRef(false);
  const preview = session.preview(context);
  const latest = useRef(preview.text); latest.current = preview.text;
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; }; }, []);
  useEffect(() => { operation.current++; lock.current = false; setBusy(false); setMessage(""); }, [preview.text]);
  function reset() { operation.current++; lock.current = false; setBusy(false); setMessage(""); setError(""); setSession(new ReferenceMappingSession(context)); }
  async function copy() {
    if (disabled || lock.current || !preview.current || !preview.text) return;
    const id = ++operation.current, text = preview.text; lock.current = true; setBusy(true); setMessage("");
    try { await navigator.clipboard.writeText(text); if (alive.current && operation.current === id && latest.current === text) setMessage("已复制本地计划编号预览；没有上传或写入提示词。"); }
    catch { if (alive.current && operation.current === id && latest.current === text) setMessage("复制失败，请手动选择下方文本。"); }
    finally { if (alive.current && operation.current === id) { lock.current = false; setBusy(false); } }
  }
  return <fieldset disabled={disabled || busy}><legend>参考图临时计划编号（仅预览／复制）</legend>
    <p className="helper">仅列当前范围资产关联的图片 ID，不验证图片存在、哈希或上传状态。同一图片共用一个编号；填写互不重复的 1–200 整数，范围仅为本应用输入上限，不是提供方限制。留空不指定。不保存、不进入临时编辑或自动写入；切换位置或关闭面板会丢弃。</p>
    {!preview.current && <p role="alert">来源或修订已变化，旧编号已失效。请重新开始并逐项填写，不会自动恢复旧编号。</p>}
    {preview.current && session.rows.map(row => <label key={row.imageId}>{row.assets.map(a => a.name).join("；")}（图片 ID：{row.imageId}）
      <input type="number" min={1} max={200} step={1} value={preview.entries.find(e => e.imageId === row.imageId)?.index ?? ""} onChange={event => {
        try { session.update(context, row.imageId, event.target.value === "" ? null : Number(event.target.value)); render(n => n + 1); setError(""); setMessage(""); }
        catch { setError("编号须为唯一的 1–200 整数；无效修改未采用。"); }
      }} /></label>)}
    {preview.current && !session.rows.length && <p>当前范围没有带参考图 ID 的关联资产。</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="text-button" onClick={reset}>清空编号并按当前来源重新开始</button>
    <button type="button" className="text-button" disabled={!preview.text || !preview.current} onClick={() => { void copy(); }}>复制含计划编号的预览</button>
    {message && <p role="status">{message}</p>}
    {preview.text && <label>计划编号预览<textarea readOnly rows={8} value={preview.text} /></label>}
  </fieldset>;
}
