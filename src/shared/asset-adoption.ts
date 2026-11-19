import { z } from "zod";
import { AssetCandidateSession, type AssetCandidatePreview } from "./asset-candidate";
import { addAsset, MAX_ASSETS } from "./assets";
import { setAssetLink } from "./asset-links";
import { invalidateChangedConfirmation } from "./frames";
import type { TaskWorkspace } from "./models";
import type { PlanStyleContext } from "./prompts";
import type { InspectionSaveState } from "./inspection-summary";

export interface AssetAdoptionContext { taskId: string; revision: number; workspace: TaskWorkspace; planStyle: PlanStyleContext }
export interface AssetAdoptionInput extends AssetAdoptionContext { saveState: InspectionSaveState; selectedKeys: string[]; accepted: boolean }
export type AssetAdoptionBlocker = "INVALID_INPUT" | "APPLYING" | "ALREADY_APPLIED" | "NOT_ACCEPTED" | "UNSAVED" | "STALE_PREVIEW"
  | "INVALID_SELECTION" | "UNMATCHED_SHOTS" | "DUPLICATE_NAME" | "CAPACITY" | "INVALID_ID";
const blocked = (reason: AssetAdoptionBlocker) => Object.freeze({ status: "blocked" as const, reason });
const uuid = z.string().uuid();
const normalizedName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Internal manual opt-in draft boundary only; accepted is caller intent, not independent user
 * authentication. No database write, provider, automatic selection, UI, IPC or ID allocation policy.
 * Duplicate normalized names across ANY type reject ambiguity, never merge existing entities. */
export class AssetAdoptionSession {
  readonly preview: AssetCandidatePreview;
  #source: AssetCandidateSession;
  #taskId: string;
  #revision: number;
  #plan: string;
  #consumed = false;
  #applying = false;
  constructor(source: AssetCandidateSession, context: AssetAdoptionContext) {
    if (!(source instanceof AssetCandidateSession) || !uuid.safeParse(context.taskId).success
      || !Number.isSafeInteger(context.revision) || context.revision < 0) throw new Error("资产采用上下文无效。");
    this.#source = source; this.#taskId = context.taskId; this.#revision = context.revision;
    this.#plan = JSON.stringify(context.planStyle);
    this.preview = source.preview(context.workspace);
    // Readonly is also enforced at runtime; don't permit swapping a forged preview.
    Object.defineProperty(this, "preview", { value: this.preview, writable: false, configurable: false, enumerable: true });
  }
  apply(input: AssetAdoptionInput, createId: () => string) {
    if (this.#applying) return blocked("APPLYING");
    this.#applying = true;
    try {
      if (this.#consumed) return blocked("ALREADY_APPLIED");
      if (input.accepted !== true) return blocked("NOT_ACCEPTED");
      if (!input.saveState || input.saveState.dirty || input.saveState.saving || input.saveState.conflict || input.saveState.error !== null) return blocked("UNSAVED");
      if (input.taskId !== this.#taskId || input.revision !== this.#revision || JSON.stringify(input.planStyle) !== this.#plan
        || !this.#source.isCurrent(this.preview, input.workspace)) return blocked("STALE_PREVIEW");
      if (!Array.isArray(input.selectedKeys) || !input.selectedKeys.length || input.selectedKeys.length > MAX_ASSETS
        || input.selectedKeys.some(key => typeof key !== "string") || new Set(input.selectedKeys).size !== input.selectedKeys.length) return blocked("INVALID_SELECTION");
      const chosen = input.selectedKeys.map(key => this.preview.candidates.find(candidate => candidate.key === key));
      if (chosen.some(candidate => !candidate)) return blocked("INVALID_SELECTION");
      const candidates = chosen.filter(candidate => candidate !== undefined);
      if (candidates.some(candidate => candidate.unmatchedShotIds.length
        || candidate.matchedShotIds.some(id => !input.workspace.shots.some(shot => shot.id === id)))) return blocked("UNMATCHED_SHOTS");
      if (input.workspace.assets.length + candidates.length > MAX_ASSETS) return blocked("CAPACITY");
      const names = new Set(input.workspace.assets.map(asset => normalizedName(asset.name)));
      for (const candidate of candidates) {
        const name = normalizedName(candidate.name);
        if (names.has(name)) return blocked("DUPLICATE_NAME");
        names.add(name);
      }
      const occupied = new Set([input.taskId, "script", ...input.workspace.shots.map(shot => shot.id), ...input.workspace.assets.map(asset => asset.id),
        ...input.workspace.assets.flatMap(asset => asset.referenceImageId ? [asset.referenceImageId] : []),
        ...(input.workspace.frames?.candidates.flatMap(frame => [frame.id, frame.imageId]) ?? []), ...Object.keys(input.workspace.productionPositions ?? {})]);
      const inputFingerprint = JSON.stringify(input);
      const ids: string[] = [];
      for (const candidate of candidates) {
        void candidate;
        let id: string;
        try { id = createId(); } catch { return blocked("INVALID_ID"); }
        if (!uuid.safeParse(id).success || occupied.has(id)) return blocked("INVALID_ID");
        occupied.add(id); ids.push(id);
      }
      if (JSON.stringify(input) !== inputFingerprint || !this.#source.isCurrent(this.preview, input.workspace) || JSON.stringify(input.planStyle) !== this.#plan) return blocked("STALE_PREVIEW");
      let next = input.workspace;
      for (const [index, candidate] of candidates.entries()) {
        const id = ids[index]!;
        next = addAsset(next, id, candidate.type);
        next = { ...next, assets: next.assets.map(asset => asset.id === id ? { ...asset, name: candidate.name, description: candidate.description } : asset) };
        for (const shotId of candidate.matchedShotIds) next = setAssetLink(next, id, shotId, true);
      }
      next = invalidateChangedConfirmation(input.workspace, next, input.planStyle);
      this.#consumed = true;
      return { status: "draft-applied" as const, workspace: next };
    } catch { return blocked("INVALID_INPUT"); } finally { this.#applying = false; }
  }
}
