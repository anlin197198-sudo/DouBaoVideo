import { capturePlanList, planListContext, type PlanListView } from "../../../shared/plan-list-view";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Plan, VideoTask } from "../../../shared/models";
import type { CommandInputs } from "../../../shared/bridge";
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

function datesFor(plan: Plan): string[] {
  return Array.from({ length: 7 }, (_, day) => {
    const date = new Date(plan.startDate + "T12:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + day);
    return date.toISOString().slice(0, 10);
  });
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
  onCreate: (input: CommandInputs["plans.create"]) => Promise<boolean>;
  onToggle: (plan: Plan) => void;
  onOpenTask: (task: VideoTask) => void;
  onReload: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const selectedDay = view.day;
  const plan = plans.find((item) => item.id === view.planId) ?? plans[0];
  const dates = plan ? datesFor(plan) : [];
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const saved = await onCreate({
      title: String(data.get("title")),
      style: data.get("style") as Plan["style"],
      startDate: String(data.get("startDate")),
      dailyCount: Number(data.get("dailyCount")),
      executionTime: String(data.get("executionTime")),
      styleNotes: String(data.get("styleNotes") ?? ""),
    });
    if (saved) {
      setCreating(false);
      onViewChange({ planId: null, day: 0 });
    }
  }

  return (
    <>
      <div className="page-heading">
        <h1>周计划</h1>
        <button className="primary" onClick={() => setCreating(true)}>
          新建计划
        </button>
      </div>
      {!plan ? (
        <div className="empty">
          <h2>开始制作下一周的视频</h2>
          <p>先确定主题和整体风格，再逐条整理剧本与画面。</p>
          <button className="text-button" onClick={() => setCreating(true)}>
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
          busy={busy}
          onClose={() => setCreating(false)}
        >
          <form onSubmit={submit}>
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
            <footer className="modal-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "正在保存…" : "创建一周任务"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
