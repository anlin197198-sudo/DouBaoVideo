/** Session-only navigation context; never part of a saved workspace. */
export interface PlanListContext { planId: string; businessDate: string; scrollY: number; archivedOpen: boolean; historicalOpen: boolean }
export interface PlanListView { planId: string | null; day: number; context?: PlanListContext }
export function planListContext(view: PlanListView, planId: string | undefined, businessDate: string | undefined): PlanListContext | null {
  const value = view.context;
  return value && value.planId === planId && value.businessDate === businessDate
    ? { ...value, scrollY: Number.isFinite(value.scrollY) ? Math.max(0, value.scrollY) : 0 } : null;
}
export function capturePlanList(view: PlanListView, planId: string, businessDate: string, scrollY: number, archivedOpen: boolean, historicalOpen: boolean): PlanListView {
  return { ...view, planId, context: { planId, businessDate, scrollY: Number.isFinite(scrollY) ? Math.max(0, scrollY) : 0, archivedOpen, historicalOpen } };
}
