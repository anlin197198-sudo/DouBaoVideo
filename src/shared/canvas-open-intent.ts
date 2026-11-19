import { z } from "zod";
import type { TaskWorkspace } from "./models";
import type { PlanStyleContext } from "./prompts";
import { nextLocalStep, productionNodes } from "./canvas-production";
import type { InspectionSaveState } from "./inspection-summary";
export interface CanvasOpenContext {
  taskId: string; revision: number; workspace: TaskWorkspace; plan: PlanStyleContext;
}
function fingerprint(context: CanvasOpenContext): string {
  if (!z.string().uuid().safeParse(context.taskId).success || !Number.isSafeInteger(context.revision) || context.revision < 0) throw new Error("INVALID_CONTEXT");
  return JSON.stringify(context);
}
/** Internal route contract only, not wired to generic plan/title/archive opens.
 * A future caller must distinguish an explicit continue action. Stored status alone is not intent.
 * One attempt consumes the intent even when blocked, so it cannot navigate later after new edits.
 * No selection, viewport, save or dispatch effects occur here. */
export class CanvasOpenIntent {
  #fingerprint: string; #target: string; #consumed = false;
  private constructor(fingerprint: string, target: string) { this.#fingerprint = fingerprint; this.#target = target; }
  static prepare(action: "open-current-local-step" | "open-canvas", context: CanvasOpenContext): CanvasOpenIntent | null {
    if (action !== "open-current-local-step") return null;
    try {
      const stamp = fingerprint(context), target = nextLocalStep(context.workspace, context.plan).target;
      const nodes = productionNodes(context.workspace, context.plan);
      const ids = new Set(["script", ...context.workspace.shots.map(s => s.id), ...context.workspace.assets.map(a => a.id), ...nodes.prompts.map(p => p.id), ...nodes.frames.map(f => f.id)]);
      if (!ids.has(target)) return null; // e.g. add-shot/assets are actions, not existing nodes
      return new CanvasOpenIntent(stamp, target);
    } catch { return null; }
  }
  consume(context: CanvasOpenContext, state: InspectionSaveState, busy: boolean): Readonly<{ taskId: string; target: string }> | null {
    if (this.#consumed) return null;
    this.#consumed = true;
    try {
      if (busy || state.dirty || state.saving || state.error || state.conflict || fingerprint(context) !== this.#fingerprint) return null;
      return Object.freeze({ taskId: context.taskId, target: this.#target });
    } catch { return null; }
  }
  cancel(): void { this.#consumed = true; }
}
