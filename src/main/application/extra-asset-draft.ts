import { createHash } from "node:crypto";
import { z } from "zod";
import { currentFrame, hasCurrentConfirmation } from "../../shared/frames";
import { findPrompt } from "../../shared/prompts";
import type { ApplicationDatabase } from "../infrastructure/database";
import type { ReferenceImageStore } from "../infrastructure/reference-image-store";
import { WorkspaceRepository } from "../infrastructure/workspace-repository";

const requestSchema = z.object({ taskId: z.string().uuid(), accountId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  selectedAssetIds: z.array(z.string().uuid()).min(1).max(200).refine(ids => new Set(ids).size === ids.length) }).strict();
export type ExtraAssetDraftRequest = z.infer<typeof requestSchema>;
/** Internal evidence contract, NOT a claim that Doubao supports this role or a public input API.
 * No production adapter is supplied. Only the verified first-last mode may authorize local confirmation. */
export interface ExtraAssetEvidencePort { read(accountId: string): unknown }
const evidenceSchema = z.object({ provider: z.literal("doubao"), accountId: z.string().uuid(), evidenceId: z.string().uuid(),
  observedAt: z.number().finite(), expiresAt: z.number().finite(), login: z.literal("verified"), charge: z.literal("verified-free"),
  mode: z.literal("first-last"), roles: z.array(z.enum(["first", "last"])).max(2),
  aspectRatios: z.array(z.string().max(20)).max(20), durations: z.array(z.number().int().positive()).max(20),
  maxExtraImages: z.number().int().min(0).max(200),
  additionalReferences: z.array(z.object({ role: z.literal("extra-reference-image"),
    types: z.array(z.enum(["person", "scene", "prop"])).min(1).max(3) }).strict()).max(1) }).strict();
export type ExtraAssetCapabilityEvidence = z.infer<typeof evidenceSchema>;
export type ExtraAssetDraftBlocker = "INVALID_REQUEST" | "INVALID_PREVIEW" | "NOT_ACCEPTED" | "STALE_DRAFT" | "ACCOUNT_BLOCKED"
  | "CONFIRMATION_REQUIRED" | "ASSET_NOT_LINKED" | "IMAGE_UNAVAILABLE" | "CAPABILITY_UNVERIFIED" | "UNSUPPORTED_INPUT" | "READ_FAILED";
class Block extends Error { constructor(readonly reason: ExtraAssetDraftBlocker) { super(reason); } }
const reject = (reason: ExtraAssetDraftBlocker) => Object.freeze({ status: "blocked" as const, reason, submitted: false as const });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Memory-only opt-in contract. No UI/IPC, persistence, transport or VideoPreflight integration.
 * Local confirmation is NOT submission authorization; every future consumer must revalidate. */
export class ExtraAssetDraftService {
  #drafts = new WeakMap<object, { request: ExtraAssetDraftRequest; fingerprint: string }>();
  constructor(private readonly database: ApplicationDatabase, private readonly references: ReferenceImageStore,
    private readonly capabilities: ExtraAssetEvidencePort, private readonly now: () => number = Date.now) {}

  private capture(request: ExtraAssetDraftRequest) {
    const db = this.database.connection;
    const account = db.prepare("SELECT a.enabled,r.state,r.revision FROM accounts a JOIN account_removal r ON r.account_id=a.id WHERE a.id=?").get(request.accountId);
    if (!account || account.enabled !== 1 || account.state !== "present") throw new Block("ACCOUNT_BLOCKED");
    const task = new WorkspaceRepository(this.database).getTask(request.taskId);
    if (task.revision !== request.expectedRevision) throw new Block("STALE_DRAFT");
    const row = db.prepare("SELECT style,style_notes FROM plans WHERE id=?").get(task.planId);
    if (!row || !["comic", "realistic"].includes(String(row.style))) throw new Block("READ_FAILED");
    const plan = { style: row.style as "comic" | "realistic", styleNotes: String(row.style_notes ?? "") };
    if (!hasCurrentConfirmation(task.workspace, plan)) throw new Block("CONFIRMATION_REQUIRED");
    const imageSeal = (imageId: string) => {
      const image = db.prepare("SELECT task_id,content_hash FROM reference_images WHERE id=?").get(imageId);
      if (!image || image.task_id !== task.id) throw new Block("IMAGE_UNAVAILABLE");
      const bytes = this.references.readVerifiedBytes(imageId);
      if (!bytes || digest(bytes) !== image.content_hash) throw new Block("IMAGE_UNAVAILABLE");
      return { imageId, sha256: digest(bytes), byteLength: bytes.length };
    };
    const frames = (["first", "last"] as const).map(role => {
      const frame = currentFrame(task.workspace, role)!;
      return { role, candidateId: frame.id, ...imageSeal(frame.imageId) };
    });
    const assets = request.selectedAssetIds.map(id => {
      const asset = task.workspace.assets.find(item => item.id === id);
      const linkedShots = task.workspace.shots.filter(shot => task.workspace.assetLinks.some(link => link.assetId === id && link.shotId === shot.id)).map(shot => shot.id);
      if (!asset || !linkedShots.length) throw new Block("ASSET_NOT_LINKED");
      if (!asset.referenceImageId) throw new Block("IMAGE_UNAVAILABLE");
      return { assetId: id, type: asset.type, version: asset.version, metadata: structuredClone(asset),
        metadataFingerprint: digest(JSON.stringify(asset)), linkedShots, role: "extra-reference-image" as const, ...imageSeal(asset.referenceImageId) };
    });
    const video = findPrompt(task.workspace, "video", null)!;
    return { taskId: task.id, taskRevision: task.revision, accountId: request.accountId, accountRevision: Number(account.revision),
      mode: "first-last" as const, video: { text: video.text, version: video.version, inputSnapshot: video.inputSnapshot },
      confirmation: { ...task.workspace.frames!.confirmation! }, parameters: { ...task.workspace.frames!.parameters }, frames, assets };
  }

  private capability(snapshot: ReturnType<ExtraAssetDraftService["capture"]>) {
    const start = this.now();
    try {
      const parsed = evidenceSchema.safeParse(this.capabilities.read(snapshot.accountId));
      const end = this.now();
      if (!parsed.success || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return { reason: "CAPABILITY_UNVERIFIED" as const };
      const evidence = parsed.data;
      if (evidence.accountId !== snapshot.accountId || evidence.observedAt > start || evidence.expiresAt <= end
        || evidence.expiresAt <= evidence.observedAt) return { reason: "CAPABILITY_UNVERIFIED" as const };
      if (snapshot.assets.length > evidence.maxExtraImages || !evidence.roles.includes("first") || !evidence.roles.includes("last") || !evidence.aspectRatios.includes(snapshot.parameters.aspectRatio)
        || !evidence.durations.includes(snapshot.parameters.durationSeconds)
        || snapshot.assets.some(asset => !evidence.additionalReferences.some(role => role.types.includes(asset.type)))) return { reason: "UNSUPPORTED_INPUT" as const };
      return { evidenceId: evidence.evidenceId };
    } catch { return { reason: "CAPABILITY_UNVERIFIED" as const }; }
  }

  preview(raw: ExtraAssetDraftRequest) {
    try {
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) return reject("INVALID_REQUEST");
      return this.database.transaction(() => {
        const snapshot = this.capture(parsed.data), capability = this.capability(snapshot);
        const preview = freeze({ status: "draft-only" as const, submitted: false as const, snapshot,
          capabilityBlocker: capability.reason ?? null });
        this.#drafts.set(preview, { request: parsed.data, fingerprint: digest(JSON.stringify(snapshot)) });
        return preview;
      });
    } catch (error) { return reject(error instanceof Block ? error.reason : "READ_FAILED"); }
  }

  /** accepted is an internal caller assertion, not independently authenticated browser/user intent. */
  confirm(preview: object, acceptance: { accepted: boolean }) {
    try {
      if (!acceptance || acceptance.accepted !== true) return reject("NOT_ACCEPTED");
      const stored = this.#drafts.get(preview);
      if (!stored) return reject("INVALID_PREVIEW");
      return this.database.transaction(() => {
        const snapshot = this.capture(stored.request);
        if (digest(JSON.stringify(snapshot)) !== stored.fingerprint) return reject("STALE_DRAFT");
        const capability = this.capability(snapshot);
        if (capability.reason) return reject(capability.reason);
        return freeze({ status: "local-confirmed-only" as const, submitted: false as const, snapshot,
          evidenceId: capability.evidenceId, fingerprint: stored.fingerprint });
      });
    } catch (error) { return reject(error instanceof Block ? error.reason : "READ_FAILED"); }
  }
}
