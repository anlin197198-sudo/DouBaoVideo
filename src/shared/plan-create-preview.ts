import type { CommandInputs } from "./bridge";
import { weekDates } from "./plan-changes";
import { commandSchemas } from "./validation";

type Input = Readonly<CommandInputs["plans.create"]>;
export type CreateRequestId = ReturnType<typeof crypto.randomUUID>;
export type CreatePreview = Readonly<{ input: Input; dates: readonly string[]; total: number }>;
export type CreatePhase = "editing" | "preview" | "writing" | "uncertain" | "check-only" | "refreshing" | "saved" | "complete" | "checked";
export function createPlanPreview(raw: unknown): CreatePreview {
  const result = commandSchemas["plans.create"].safeParse(raw);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "请检查计划参数。");
  const input = Object.freeze(result.data), dates = Object.freeze(weekDates(input.startDate));
  return Object.freeze({ input, dates, total: dates.length * input.dailyCount });
}

/** One frozen, explicitly confirmed input. Missing replies never authorize a new request. */
export class PlanCreateReview {
  phase: CreatePhase = "editing";
  preview: CreatePreview | null = null;
  planId: string | null = null;
  private requestId: CreateRequestId | null = null;
  constructor(private readonly id: () => CreateRequestId, private readonly changed: () => void) {}
  private set(phase: CreatePhase) { this.phase = phase; this.changed(); }
  get editable() { return this.phase === "editing" || this.phase === "preview"; }
  get canClose() { return this.editable || this.phase === "saved" || this.phase === "complete" || this.phase === "checked"; }
  discardPreview() {
    if (!this.editable) return;
    this.preview = null; this.set("editing");
  }
  inspect(raw: unknown) {
    if (!this.editable) return;
    this.discardPreview();
    this.preview = createPlanPreview(raw); this.set("preview");
  }
  async confirm(preview: CreatePreview, raw: unknown, write: Writer, refresh: Refresher) {
    if (this.phase !== "preview" || this.preview !== preview) return;
    let matches = false;
    try { matches = JSON.stringify(createPlanPreview(raw).input) === JSON.stringify(preview.input); } catch { /* Stale. */ }
    if (!matches) { this.discardPreview(); return; }
    this.requestId = this.id();
    await this.send(write, refresh, false);
  }
  async retry(write: Writer, refresh: Refresher) {
    if (this.phase === "uncertain") await this.send(write, refresh, true);
  }
  private async send(write: Writer, refresh: Refresher, retry: boolean) {
    if (!this.requestId || !this.preview) return;
    this.set("writing");
    try { this.planId = (await write(this.preview.input, this.requestId)).planId; }
    catch { this.set(retry ? "check-only" : "uncertain"); return; }
    if (!this.planId) { this.set(retry ? "check-only" : "uncertain"); return; }
    this.requestId = null;
    this.set("saved");
    await this.refresh(refresh);
  }
  async refresh(refresh: Refresher) {
    const previous = this.phase;
    if (previous !== "saved" && previous !== "uncertain" && previous !== "check-only") return;
    this.set("refreshing");
    try {
      await refresh(this.planId);
      this.requestId = null;
      this.set(previous === "saved" ? "complete" : "checked");
    } catch { this.set(previous); }
  }
}
type Writer = (input: Input, id: CreateRequestId) => Promise<{ planId: string }>;
type Refresher = (planId: string | null) => Promise<void>;
