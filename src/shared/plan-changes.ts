import type { Plan, VideoTask, VisualStyle } from "./models";
import { inheritsStyleNotes } from "./prompts";

export interface PlanChanges {
  title: string; style: VisualStyle; startDate: string; dailyCount: number; executionTime: string;
  styleNotes?: string;
}
export interface PlanChangeDay {
  date: string; desired: number; locked: VideoTask[]; editable: VideoTask[];
  add: number; remove: number;
}
export interface PlanChangePreview {
  token: string; plan: Plan; changes: PlanChanges; days: PlanChangeDay[];
  outside: VideoTask[]; lockedOutside: VideoTask[]; styleAffected: string[]; blockers: string[];
}
export function weekDates(startDate: string): string[] {
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(startDate + "T12:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}
export function planChangePreview(plan: Plan, tasks: VideoTask[], lockedIds: Set<string>, changes: PlanChanges): Omit<PlanChangePreview, "token"> {
  const active = tasks.filter(task => task.scheduleActive !== false);
  const dates = weekDates(changes.startDate);
  const days = dates.map(date => {
    const sameDay = active.filter(task => task.businessDate === date);
    const locked = sameDay.filter(task => lockedIds.has(task.id));
    const editable = sameDay.filter(task => !lockedIds.has(task.id));
    return { date, desired: changes.dailyCount, locked, editable,
      add: Math.max(0, changes.dailyCount - sameDay.length),
      remove: Math.max(0, sameDay.length - changes.dailyCount) };
  });
  return { plan, changes, days,
    outside: active.filter(task => !dates.includes(task.businessDate) && !lockedIds.has(task.id)),
    lockedOutside: active.filter(task => !dates.includes(task.businessDate) && lockedIds.has(task.id)),
    styleAffected: tasks.filter(task => !lockedIds.has(task.id) && (
      (plan.style !== changes.style && !task.workspace.promptSettings?.style)
      || ((plan.styleNotes ?? "") !== (changes.styleNotes ?? "") && inheritsStyleNotes(task.workspace)))).map(task => task.id),
    blockers: days.filter(day => day.locked.length > day.desired).map(day => `${day.date} 已有 ${day.locked.length} 条执行记录，不能减少到 ${day.desired} 条。`),
  };
}
export function removalProblem(preview: PlanChangePreview, selected: string[]): string | null {
  if (preview.blockers.length) return preview.blockers[0]!;
  const ids = new Set(selected);
  const allowed = new Set([...preview.outside, ...preview.days.flatMap(day => day.editable)].map(task => task.id));
  if (ids.size !== selected.length || selected.some(id => !allowed.has(id))) return "只能选择本次预览中尚未执行的排期任务。";
  if (preview.outside.some(task => !ids.has(task.id))) return "请明确选择所有新日期范围之外的未执行任务移出排期。";
  for (const day of preview.days) {
    if (day.editable.filter(task => ids.has(task.id)).length !== day.remove) return `${day.date} 需要恰好选择 ${day.remove} 条任务移出排期。`;
  }
  return null;
}
