import { useState, type FormEvent } from "react";
import type { Plan, VideoTask } from "../../../shared/models";
import type { CommandInputs } from "../../../shared/bridge";
import { Modal } from "../components/Modal";

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
}: {
  plans: Plan[];
  tasks: VideoTask[];
  busy: boolean;
  view: { planId: string | null; day: number };
  onViewChange: (view: { planId: string | null; day: number }) => void;
  onCreate: (input: CommandInputs["plans.create"]) => Promise<boolean>;
  onToggle: (plan: Plan) => void;
  onOpenTask: (task: VideoTask) => void;
}) {
  const [creating, setCreating] = useState(false);
  const selectedDay = view.day;
  const plan = plans.find((item) => item.id === view.planId) ?? plans[0];
  const dates = plan ? datesFor(plan) : [];
  const activeDate = dates[selectedDay];
  const dailyTasks = tasks.filter(
    (task) => task.planId === plan?.id && task.businessDate === activeDate,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const saved = await onCreate({
      title: String(data.get("title")),
      style: data.get("style") as Plan["style"],
      startDate: String(data.get("startDate")),
      dailyCount: Number(data.get("dailyCount")),
      executionTime: String(data.get("executionTime")),
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
              className="text-button"
              disabled={busy}
              onClick={() => onToggle(plan)}
            >
              {plan.enabled ? "暂停计划" : "启用计划"}
            </button>
          </div>
          <div className="week" aria-label="一周日期">
            {dates.map((date, index) => {
              const count = tasks.filter(
                (task) => task.planId === plan.id && task.businessDate === date,
              ).length;
              return (
                <button
                  key={date}
                  className="day"
                  aria-pressed={index === selectedDay}
                  onClick={() => onViewChange({ planId: plan.id, day: index })}
                >
                  <span>{date.slice(5).replace("-", "月")}日</span>
                  <strong>{date.slice(-2)}</strong>
                  <small>{count} 条任务</small>
                </button>
              );
            })}
          </div>
          <h2 className="section-heading">{activeDate} 的任务</h2>
          <table>
            <thead>
              <tr>
                <th>视频任务</th>
                <th>当前步骤</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {dailyTasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <button
                      className="title-button"
                      onClick={() => onOpenTask(task)}
                    >
                      {task.title}
                    </button>
                  </td>
                  <td className="muted">
                    {task.workspace.script ? "剧本已保存" : "待填写剧本"}
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => onOpenTask(task)}
                    >
                      打开画布
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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
              连续安排 7 天。当前先创建任务和本地制作空间。
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
