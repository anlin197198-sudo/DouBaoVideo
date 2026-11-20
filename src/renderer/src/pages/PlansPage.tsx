import { capturePlanList, planListContext, type PlanListView } from "../../../shared/plan-list-view";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Plan, VideoTask } from "../../../shared/models";
import type { CommandInputs } from "../../../shared/bridge";
import { PlanCreateReview, type CreateRequestId } from "../../../shared/plan-create-preview";
import { weekDates } from "../../../shared/plan-changes";
import { Modal } from "../components/Modal";
import { nextLocalStep } from "../../../shared/canvas-production";
import { PlanEditDialog } from "../components/PlanEditDialog";

function today(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function PlansPage({
  plans,
  tasks,
  busy,
  view,
  onViewChange,
  onCreate,
  onToggle,
  onOpenTask,
  onReload,
}: {
  plans: Plan[];
  tasks: VideoTask[];
  busy: boolean;
  view: PlanListView;
  onViewChange: (view: PlanListView) => void;
  onCreate: (input: Readonly<CommandInputs["plans.create"]>, requestId: CreateRequestId) => Promise<{ planId: string }>;
  onToggle: (plan: Plan) => void;
  onOpenTask: (task: VideoTask) => void;
  onReload: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const selectedDay = view.day;
  const plan = plans.find((item) => item.id === view.planId) ?? plans[0];
  const dates = plan ? weekDates(plan.startDate) : [];
  const activeDate = dates[selectedDay];
  const dailyTasks = tasks.filter(
    (task) => task.planId === plan?.id && task.businessDate === activeDate && task.scheduleActive !== false,
  );
  const archivedTasks = tasks.filter(task => task.planId === plan?.id && task.scheduleActive === false);
  const historicalTasks = tasks.filter(task => task.planId === plan?.id && task.scheduleActive !== false && !dates.includes(task.businessDate));

  const archivedRef = useRef<HTMLDetailsElement>(null), historicalRef = useRef<HTMLDetailsElement>(null);
  const context = planListContext(view, plan?.id, activeDate);
  // The first committed layout already includes restored disclosures. Only navigation
  // changes restore scroll; ordinary autosave/reload/toggle renders never jump the list.
  useLayoutEffect(() => {
    if (archivedRef.current) archivedRef.current.open = context?.archivedOpen ?? false;
    if (historicalRef.current) historicalRef.current.open = context?.historicalOpen ?? false;
    window.scrollTo({ top: context?.scrollY ?? 0, left: 0, behavior: "instant" });
  }, [plan?.id, activeDate]);
  function openTask(task: VideoTask) {
    if (plan && activeDate) onViewChange(capturePlanList(view, plan.id, activeDate, window.scrollY,
      archivedRef.current?.open ?? false, historicalRef.current?.open ?? false));
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    onOpenTask(task);
  }

  const [, renderCreation] = useState(0);
  const [creation, setCreation] = useState(() => new PlanCreateReview(() => crypto.randomUUID(), () => renderCreation(n => n + 1)));
  const [createError, setCreateError] = useState("");
  const createForm = useRef<HTMLFormElement>(null);
  function formInput(form: HTMLFormElement) {
    const data = new FormData(form);
    return {
      title: String(data.get("title")), style: data.get("style"), startDate: String(data.get("startDate")),
      dailyCount: Number(data.get("dailyCount")), executionTime: String(data.get("executionTime")),
      styleNotes: String(data.get("styleNotes") ?? ""),
    };
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !creation.editable) return;
    setCreateError("");
    try { creation.inspect(formInput(event.currentTarget)); }
    catch (cause) { setCreateError(cause instanceof Error ? cause.message : "无法预览。"); }
  }
  function closeCreate() {
    if (busy || !creation.canClose) return;
    if (creation.editable) creation.discardPreview();
    setCreating(false);
  }
  async function refreshCreated(planId: string | null) {
    await onReload();
    if (planId) onViewChange({ planId, day: 0 });
  }
  async function confirmCreate() {
    if (busy || !creation.preview || !createForm.current) return;
    await creation.confirm(creation.preview, formInput(createForm.current), onCreate, refreshCreated);
    if (creation.phase === "complete") closeCreate();
    else if (creation.phase === "editing") setCreateError("表单已变化，请重新预览。");
  }
  async function retryCreate() {
    if (busy) return;
    await creation.retry(onCreate, refreshCreated);
    if (creation.phase === "complete") closeCreate();
  }
  async function refreshAfterCreate() {
    if (busy) return;
    await creation.refresh(refreshCreated);
    const phase = creation.phase;
    if (phase === "complete") closeCreate();
    else if (phase !== "checked") setCreateError("刷新列表未成功，请重试刷新。");
    else setCreateError("");
  }
  function openCreate() {
    if (busy) return;
    setCreateError(""); setCreation(new PlanCreateReview(() => crypto.randomUUID(), () => renderCreation(n => n + 1))); setCreating(true);
  }

  return (
    <>
      <div className="page-heading">
        <h1>周计划</h1>
        <button className="primary" disabled={busy} onClick={openCreate}>
          新建计划
        </button>
      </div>
      {!plan ? (
        <div className="empty">
          <h2>开始制作下一周的视频</h2>
          <p>先确定主题和整体风格，再逐条整理剧本与画面。</p>
          <button className="text-button" disabled={busy} onClick={openCreate}>
            创建第一份周计划
          </button>
        </div>
      ) : (
        <>
          <div className="plan-heading">
            <select
              aria-label="选择周计划"
              value={plan.id}
              onChange={(event) => {
                onViewChange({ planId: event.target.value, day: 0 });
              }}
            >
              {plans.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
            <span className="muted">
              {plan.style === "realistic" ? "偏真人" : "漫剧"} · 每天{" "}
              {plan.dailyCount} 条 · {plan.executionTime}
            </span>
            <button
              className="text-button" disabled={busy} onClick={() => setEditing(plan)}
            >编辑计划</button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => onToggle(plan)}
            >
              {plan.enabled ? "暂停计划" : "启用计划"}
            </button>
          </div>
          <div className="week" aria-label="一周日期">
            {dates.map((date, index) => {
              const dated = tasks.filter(task => task.planId === plan.id && task.businessDate === date && task.scheduleActive !== false);
              const count = dated.length;
              return (
                <button
                  key={date}
                  className="day"
                  aria-pressed={index === selectedDay}
                  onClick={() => onViewChange({ planId: plan.id, day: index })}
                >
                  <span>{date.slice(5).replace("-", "月")}日</span>
                  <strong>{date.slice(-2)}</strong>
                  <small>{dated.filter(task => task.status === "completed").length}/{count} 已完成</small>
                </button>
              );
            })}
          </div>
          <h2 className="section-heading">{activeDate} 的任务</h2>
          <p className="helper">本地排期已保存，真实定时调度尚未接入。完成数仅按已有完成记录统计。</p>
          <table>
            <thead>
              <tr>
                <th>视频任务</th>
                <th>当前步骤</th>
                <th>计划时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {dailyTasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <button
                      className="title-button"
                      onClick={() => openTask(task)}
                    >
                      {task.title}
                    </button>
                  </td>
                  <td className="muted">
                    {task.status === "completed" ? "已完成（历史记录）" : nextLocalStep(task.workspace, plan).label}
                  </td>
                  <td>{task.executionTime ?? plan.executionTime}</td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => openTask(task)}
                    >
                      打开画布
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {historicalTasks.length > 0 && <details ref={historicalRef}><summary>历史日期任务（{historicalTasks.length}）</summary>
            <p className="helper">已有执行记录保留原日期和时间，不计入新一周日期范围。</p>
            {historicalTasks.map(task => <p key={task.id}>{task.businessDate} {task.executionTime} · {task.title} <button className="text-button" onClick={() => openTask(task)}>打开画布</button></p>)}
          </details>}
          {archivedTasks.length > 0 && <details ref={archivedRef}><summary>已移出排期，制作内容保留（{archivedTasks.length}）</summary>
            <p className="helper">这些任务不计入每日数量，也不会定时派发。可以打开画布查看、复制和继续编辑。重新加入排期入口尚未实现。</p>
            {archivedTasks.map(task => <p key={task.id}>{task.businessDate} · {task.title} <button className="text-button" onClick={() => openTask(task)}>打开保留的画布</button></p>)}
          </details>}
        </>
      )}
      {editing && <PlanEditDialog plan={editing} onClose={() => setEditing(null)} onSaved={async () => { await onReload(); onViewChange({ planId: editing.id, day: 0 }); }} />}
      {creating && (
        <Modal
          title="新建周计划"
          busy={busy || !creation.canClose}
          onClose={closeCreate}
        >
          <form ref={createForm} hidden={!creation.editable} onSubmit={submit}
            onChange={() => { creation.discardPreview(); setCreateError(""); }}>
            <fieldset disabled={busy || !creation.editable} style={{ border: 0, padding: 0 }}>
            <label>
              主题
              <input
                name="title"
                placeholder="例如，雨夜的七个片刻"
                required
                maxLength={120}
                autoFocus
              />
            </label>
            <label>
              整体风格
              <select name="style" defaultValue="realistic">
                <option value="realistic">偏真人</option>
                <option value="comic">漫剧</option>
              </select>
            </label>
            <details><summary>补充计划风格说明（可选）</summary><label>计划风格说明<textarea name="styleNotes" maxLength={5000} rows={3} placeholder="例如：低饱和色彩、柔和光线。任务默认继承，可独立覆盖。" /></label></details>
            <details>
              <summary>调整排期</summary>
              <label>
                开始日期
                <input
                  name="startDate"
                  type="date"
                  defaultValue={today()}
                  required
                />
              </label>
              <div className="form-row">
                <label>
                  每天数量
                  <input
                    name="dailyCount"
                    type="number"
                    min="1"
                    max="100"
                    defaultValue={1}
                    required
                  />
                </label>
                <label>
                  每日执行时间
                  <input
                    name="executionTime"
                    type="time"
                    defaultValue="09:30"
                    required
                  />
                </label>
              </div>
            </details>
            <p className="helper">
              连续安排 7 天，每天最多 100 条。当前先创建任务和本地制作空间。
            </p>
              <button className="text-button">预览一周任务</button>
            </fieldset>
          </form>
          {creation.phase === "preview" && creation.preview && <section aria-label="一周任务预览">
            <h3>一周任务预览</h3>
            <p>主题：{creation.preview.input.title} · {creation.preview.input.style === "comic" ? "漫剧" : "偏真人"}</p>
            {creation.preview.input.styleNotes && <p>风格说明：{creation.preview.input.styleNotes}</p>}
            <p>每天 {creation.preview.input.dailyCount} 条 · 合计 {creation.preview.total} 条 · 当地时间 {creation.preview.input.executionTime}</p>
            <ul>{creation.preview.dates.map(date => <li key={date}>{date} · {creation.preview!.input.dailyCount} 条</li>)}</ul>
            <p>仅创建本地任务与空白剧本，不发起生成或真实调度。</p>
            <footer className="modal-actions">
              <button className="text-button" disabled={busy} onClick={closeCreate}>取消，不创建</button>
              <button className="primary" disabled={busy} onClick={() => void confirmCreate()}>确认创建</button>
            </footer>
          </section>}
          {creation.phase === "writing" && <p role="status">正在创建…</p>}
          {(creation.phase === "uncertain" || creation.phase === "check-only") && <section>
            <p role="alert">创建结果未确认，计划可能已保存。请先核对列表，不要重新创建。</p>
            {creation.phase === "uncertain" && <button className="text-button" disabled={busy} onClick={() => void retryCreate()}>用原请求重查一次</button>}
            <button className="text-button" disabled={busy} onClick={() => void refreshAfterCreate()}>刷新列表以核对</button>
          </section>}
          {creation.phase === "saved" && <p role="status">已保存，只需刷新列表。<button className="text-button" disabled={busy} onClick={() => void refreshAfterCreate()}>重试刷新</button></p>}
          {creation.phase === "refreshing" && <p role="status">正在刷新列表…</p>}
          {creation.phase === "checked" && <p role="status">列表已刷新。关闭后请核对主题和日期，再决定是否新建。<button className="text-button" onClick={closeCreate}>关闭并查看列表</button></p>}
          {createError && <p role="alert">{createError}</p>}
        </Modal>
      )}
    </>
  );
}
