import { z } from "zod";
import type { StoryboardShot, TaskWorkspace } from "./models";

/** Internal JSON contract only, not a provider format or a generation/IPC capability. */
export const MAX_STORYBOARD_REPLY_CHARS = 2 * 1024 * 1024;
const candidateSchema = z.object({
  formatVersion: z.literal(1),
  shots: z.array(z.object({
    order: z.number().int().min(1).max(200), title: z.string().min(1).max(120).refine(value => value.trim().length > 0),
    visual: z.string().max(10000), action: z.string().max(10000),
    framing: z.string().max(120), motion: z.string().max(500), dialogue: z.string().max(10000),
  }).strict()).min(1).max(200),
}).strict().refine(value => value.shots.every((shot, index) => shot.order === index + 1));
export type ShotContent = Pick<StoryboardShot, "title" | "description" | "action" | "shotSize" | "cameraMovement" | "audio">;
const fields: Array<keyof ShotContent> = ["title", "description", "action", "shotSize", "cameraMovement", "audio"];
export type CandidateStatus = { status: "ready"; shotCount: number; rawRetained: true }
  | { status: "failed"; code: "INVALID_TYPE" | "TOO_LARGE" | "INVALID_JSON" | "INVALID_STRUCTURE"; message: string; rawRetained: boolean }
  | { status: "discarded"; rawRetained: false };
export interface StoryboardComparison {
  readonly mode: "ordinal-comparison-only";
  readonly rows: ReadonlyArray<{
    readonly order: number;
    readonly currentId: string | null;
    readonly current: Readonly<ShotContent> | null;
    readonly candidate: Readonly<ShotContent> | null;
    readonly changedFields: ReadonlyArray<keyof ShotContent>;
  }>;
  readonly extraCandidatePositions: number;
  readonly extraCurrentPositions: number;
}
function content(shot: ShotContent): ShotContent {
  return { title: shot.title, description: shot.description, action: shot.action, shotSize: shot.shotSize, cameraMovement: shot.cameraMovement, audio: shot.audio };
}

/** Raw replies exist only in private process memory. No logging, storage, network or adoption.
 * Oversized/non-string input is rejected without retention; other admitted failures retain
 * the FULL original text until discard. JSON serialization of this session emits no raw text.
 */
export class StoryboardCandidateSession {
  #raw: string | null = null;
  #status: CandidateStatus;
  #shots: ShotContent[] = [];
  #previews = new WeakMap<StoryboardComparison, string>();
  constructor(raw: unknown) {
    if (typeof raw !== "string") {
      this.#status = { status: "failed", code: "INVALID_TYPE", message: "仅接受 JSON 文本。", rawRetained: false }; return;
    }
    if (raw.length > MAX_STORYBOARD_REPLY_CHARS) {
      this.#status = { status: "failed", code: "TOO_LARGE", message: "回复超过本地候选大小限制，未保留内容。", rawRetained: false }; return;
    }
    this.#raw = raw;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { this.#status = { status: "failed", code: "INVALID_JSON", message: "回复不是完整的 JSON，请重新整理。", rawRetained: true }; return; }
    const result = candidateSchema.safeParse(parsed);
    if (!result.success) {
      this.#status = { status: "failed", code: "INVALID_STRUCTURE", message: "候选结构、字段长度或连续顺序不符合约定。", rawRetained: true }; return;
    }
    this.#shots = result.data.shots.map(shot => ({ title: shot.title, description: shot.visual, action: shot.action,
      shotSize: shot.framing, cameraMovement: shot.motion, audio: shot.dialogue }));
    this.#status = { status: "ready", shotCount: this.#shots.length, rawRetained: true };
  }
  get status(): Readonly<CandidateStatus> { return Object.freeze({ ...this.#status }); }
  /** Explicit local access for a future private raw-reply view; never part of status/errors. */
  readRawReply(): string | null { return this.#raw; }
  preview(workspace: TaskWorkspace): StoryboardComparison {
    if (this.#status.status !== "ready") throw new Error("没有可比较的分镜候选。");
    const rows = Array.from({ length: Math.max(workspace.shots.length, this.#shots.length) }, (_, index) => {
      const existing = workspace.shots[index], proposed = this.#shots[index];
      const current = existing ? Object.freeze(content(existing)) : null;
      const candidate = proposed ? Object.freeze(content(proposed)) : null;
      return Object.freeze({ order: index + 1, currentId: existing?.id ?? null, current, candidate,
        changedFields: Object.freeze(fields.filter(field => !current || !candidate || current[field] !== candidate[field])) });
    });
    const preview = Object.freeze({ mode: "ordinal-comparison-only" as const, rows: Object.freeze(rows),
      extraCandidatePositions: Math.max(0, this.#shots.length - workspace.shots.length),
      extraCurrentPositions: Math.max(0, workspace.shots.length - this.#shots.length) });
    // Conservative freshness only; never a patch or a stable-identity matching decision.
    this.#previews.set(preview, JSON.stringify(workspace));
    return preview;
  }
  isCurrent(preview: StoryboardComparison, workspace: TaskWorkspace): boolean {
    return this.#status.status === "ready" && this.#previews.get(preview) === JSON.stringify(workspace);
  }
  discard(): void {
    this.#raw = null; this.#shots = []; this.#previews = new WeakMap(); this.#status = { status: "discarded", rawRetained: false };
  }
}
