import { z } from "zod";
import type { AssetType, TaskWorkspace } from "./models";

/** Local JSON text contract only. No provider, asset identity allocation, adoption or persistence. */
export const MAX_ASSET_REPLY_CHARS = 2 * 1024 * 1024;
const entrySchema = z.object({ key: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(120).refine(value => !!value.trim()), description: z.string().max(10000),
  shotIds: z.array(z.string().uuid()).max(200).refine(ids => new Set(ids).size === ids.length) }).strict();
const schema = z.object({ formatVersion: z.literal(1), people: z.array(entrySchema).max(200),
  scenes: z.array(entrySchema).max(200), props: z.array(entrySchema).max(200) }).strict().refine(value => {
    const all = [...value.people, ...value.scenes, ...value.props];
    return all.length <= 200 && new Set(all.map(item => item.key)).size === all.length;
  });
export type AssetCandidateStatus = { status: "ready"; candidateCount: number; rawRetained: true }
  | { status: "failed"; code: "INVALID_TYPE" | "TOO_LARGE" | "INVALID_JSON" | "INVALID_STRUCTURE"; message: string; rawRetained: boolean }
  | { status: "discarded"; rawRetained: false };
export interface AssetCandidatePreview {
  readonly mode: "new-suggestions-only";
  readonly candidates: ReadonlyArray<Readonly<{ key: string; type: AssetType; name: string; description: string;
    matchedShotIds: ReadonlyArray<string>; unmatchedShotIds: ReadonlyArray<string> }>>;
}

/** Admitted text is retained in full only in private memory, including failed replies.
 * Oversized/non-text input is not retained. Explicit discard releases session ownership;
 * returned immutable previews are caller-owned copies, not mutable workspace entities. */
export class AssetCandidateSession {
  #raw: string | null = null;
  #status: AssetCandidateStatus;
  #entries: Array<z.infer<typeof entrySchema> & { type: AssetType }> = [];
  #previews = new WeakMap<AssetCandidatePreview, string>();
  constructor(raw: unknown) {
    if (typeof raw !== "string") { this.#status = { status: "failed", code: "INVALID_TYPE", message: "仅接受 JSON 文本。", rawRetained: false }; return; }
    if (raw.length > MAX_ASSET_REPLY_CHARS) { this.#status = { status: "failed", code: "TOO_LARGE", message: "回复超过本地候选大小限制，未保留内容。", rawRetained: false }; return; }
    this.#raw = raw;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { this.#status = { status: "failed", code: "INVALID_JSON", message: "回复不是完整的 JSON，请重新整理。", rawRetained: true }; return; }
    const result = schema.safeParse(parsed);
    if (!result.success) { this.#status = { status: "failed", code: "INVALID_STRUCTURE", message: "资产候选分组、字段或引用格式不符合约定。", rawRetained: true }; return; }
    for (const [group, type] of [["people", "person"], ["scenes", "scene"], ["props", "prop"]] as const)
      this.#entries.push(...result.data[group].map(entry => ({ ...entry, type })));
    this.#status = { status: "ready", candidateCount: this.#entries.length, rawRetained: true };
  }
  get status(): Readonly<AssetCandidateStatus> { return Object.freeze({ ...this.#status }); }
  readRawReply(): string | null { return this.#raw; }
  preview(workspace: TaskWorkspace): AssetCandidatePreview {
    if (this.#status.status !== "ready") throw new Error("没有可预览的资产候选。");
    const shotIds = new Set(workspace.shots.map(shot => shot.id));
    const candidates = this.#entries.map(entry => Object.freeze({ key: entry.key, type: entry.type, name: entry.name,
      description: entry.description, matchedShotIds: Object.freeze(entry.shotIds.filter(id => shotIds.has(id))),
      unmatchedShotIds: Object.freeze(entry.shotIds.filter(id => !shotIds.has(id))) }));
    const preview = Object.freeze({ mode: "new-suggestions-only" as const, candidates: Object.freeze(candidates) });
    this.#previews.set(preview, JSON.stringify(workspace));
    return preview;
  }
  isCurrent(preview: AssetCandidatePreview, workspace: TaskWorkspace): boolean {
    return this.#status.status === "ready" && this.#previews.get(preview) === JSON.stringify(workspace);
  }
  discard(): void { this.#raw = null; this.#entries = []; this.#previews = new WeakMap(); this.#status = { status: "discarded", rawRetained: false }; }
}
