import { useRef, useState, type FormEvent } from "react";
import type { Plan } from "../../../shared/models";
import type { PlanChangePreview, PlanChanges } from "../../../shared/plan-changes";
import { removalProblem } from "../../../shared/plan-changes";
import { command } from "../api/client";
import { Modal } from "./Modal";
import { AppliedMutation } from "../../../shared/applied-mutation";

export function PlanEditDialog({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => Promise<void> }) {
  const [changes, setChanges] = useState<PlanChanges>({ title: plan.title, style: plan.style, startDate: plan.startDate,
    dailyCount: plan.dailyCount, executionTime: plan.executionTime, styleNotes: plan.styleNotes ?? "" });
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const mutation = useRef(new AppliedMutation());
  const [error, setError] = useState("");
  const lock = useRef(false);
  const request = useRef<{ key: string; id: ReturnType<typeof crypto.randomUUID> } | null>(null);
  function edit(patch: Partial<PlanChanges>) {
    if (mutation.current.applied) return;
    setChanges(value => ({ ...value, ...patch })); setPreview(null); setSelected([]); setError("");
  }
  async function inspect(event: FormEvent) {
    event.preventDefault(); if (lock.current || mutation.current.applied) return;
    lock.current = true; setBusy(true); setError(""); setPreview(null); setSelected([]);
    try { setPreview(await command("plans.previewEdit", { id: plan.id, changes })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取影响预览失败。"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function apply() {
    if (!preview || lock.current || mutation.current.applied || removalProblem(preview, selected)) return;
    lock.current = true; setBusy(true); setError("");
    const input = { id: plan.id, changes: preview.changes, previewToken: preview.token, removeTaskIds: [...selected].sort() };
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      await mutation.current.commit(() => command("plans.applyEdit", input, request.current!.id));
      setApplied(true);
      setPreview(null); setSelected([]);
      await mutation.current.refresh(onSaved); onClose();
    } catch (cause) {
      setError(mutation.current.applied ? "修改已保存，列表刷新失败。请重试刷新；关闭不会撤销已保存的变更。"
        : cause instanceof Error ? cause.message : "修改未完成，请重试。");
      if (!mutation.current.applied && cause && typeof cause === "object" && "code" in cause && cause.code === "CONFLICT") {
        setPreview(null); setSelected([]);
      }
    } finally { lock.current = false; setBusy(false); }
  }
  async function retryRefresh() {
    if (lock.current || !mutation.current.applied) return;
    lock.current = true; setBusy(true); setError("");
    try { await mutation.current.refresh(onSaved); onClose(); }
    catch { setError("修改已保存，列表刷新仍未成功。请重试刷新或关闭后刷新工作区。"); }
    finally { lock.current = false; setBusy(false); }
  }
  const problem = preview ? removalProblem(preview, selected) : null;
  const checkbox = (task: PlanChangePreview["outside"][number]) => <label key={task.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <input type="checkbox" style={{ width: "auto" }} disabled={busy} checked={selected.includes(task.id)}
      onChange={event => setSelected(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />
    移出：{task.businessDate} · {task.title}（剧本 {task.workspace.script.length} 字，{task.workspace.shots.length} 镜头）
  </label>;
  return <Modal title="编辑计划与排期" busy={busy} onClose={onClose}>
    {!applied && <form onSubmit={inspect}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <label>主题<input required maxLength={120} value={changes.title} onChange={e => edit({ title: e.target.value })} /></label>
        <label>整体风格<select value={changes.style} onChange={e => edit({ style: e.target.value as Plan["style"] })}>
          <option value="realistic">偏真人</option><option value="comic">漫剧</option>
        </select></label>
        <label>计划风格说明（任务默认继承）<textarea maxLength={5000} rows={3} value={changes.styleNotes ?? ""} onChange={e => edit({ styleNotes: e.target.value })} /></label>
        <label>开始日期<input type="date" required value={changes.startDate} onChange={e => edit({ startDate: e.target.value })} /></label>
        <div className="form-row"><label>每天数量（1–100）<input type="number" min={1} max={100} required value={changes.dailyCount}
          onChange={e => edit({ dailyCount: Number(e.target.value) })} /></label>
          <label>每日执行时间<input type="time" required value={changes.executionTime} onChange={e => edit({ executionTime: e.target.value })} /></label></div>
        <p className="helper">按实际日期匹配，已有内容不随开始日期平移。新日期补建空白任务；移出任务保留在列表下方。已有任务标题和制作内容不会被主题修改覆盖。</p>
        <button className={preview ? "text-button" : "primary"}>{busy ? "处理中…" : preview ? "重新读取影响预览" : "预览变更影响"}</button>
      </fieldset>
    </form>}
    {error && <p role="alert">{error}</p>}
    {applied && <section aria-label="变更已保存"><p role="status">计划修改已保存。当前只需刷新列表，不会再次提交变更。</p>
      <footer className="modal-actions"><button className="text-button" disabled={busy} onClick={onClose}>关闭</button>
        <button className="primary" disabled={busy} onClick={() => void retryRefresh()}>{busy ? "正在刷新…" : "重试刷新"}</button></footer>
    </section>}
    {preview && <section aria-label="排期变更影响">
      <h3>确认变更影响</h3>
      <p>{preview.plan.title} → {preview.changes.title}；时间 {preview.plan.executionTime} → {preview.changes.executionTime}。</p>
      <p>将新增 {preview.days.reduce((sum, day) => sum + day.add, 0)} 条；移出 {preview.outside.length + preview.days.reduce((sum, day) => sum + day.remove, 0)} 条。</p>
      <p>风格：{preview.plan.style === "comic" ? "漫剧" : "偏真人"} → {preview.changes.style === "comic" ? "漫剧" : "偏真人"}。{preview.styleAffected.length} 条继承任务需核对提示词，已有图片确认将失效。独立任务风格保持。</p>
      <details><summary>风格说明变更对比</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>原说明：{preview.plan.styleNotes || "（空）"}</p><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>新说明：{preview.changes.styleNotes || "（空）"}</p></details>
      <p className="helper">风格与说明分别继承；任务独立覆盖的说明（含明确空说明）不会跟随计划说明变更。</p>
      <p className="helper">已执行任务占原日期的计划数量，不改日期、时间或制作记录。新增任务不复用归档内容；当前只更新本地排期，不触发真实生成或调度。</p>
      {preview.days.map(day => <div key={day.date} style={{ marginBottom: 12 }}>
        <strong>{day.date}：目标 {day.desired} 条，锁定 {day.locked.length} 条，新增 {day.add} 条，须选移出 {day.remove} 条</strong>
        {day.remove > 0 && day.editable.map(checkbox)}
      </div>)}
      {preview.outside.length > 0 && <><h4>新日期范围之外，必须明确选择移出</h4>{preview.outside.map(checkbox)}</>}
      {preview.lockedOutside.length > 0 && <p>范围外 {preview.lockedOutside.length} 条已有执行记录，将保留原日期并在“历史日期任务”显示。</p>}
      {problem && <p role="status">{problem}</p>}
      <footer className="modal-actions"><button className="text-button" disabled={busy} onClick={onClose}>取消，不修改</button>
        <button className="primary" disabled={busy || !!problem} onClick={() => void apply()}>{busy ? "正在保存…" : "确认应用这些变更"}</button></footer>
    </section>}
  </Modal>;
}
