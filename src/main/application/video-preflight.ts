import { createHash } from "node:crypto";
import { z } from "zod";
import { currentFrame, hasCurrentConfirmation } from "../../shared/frames";
import { findPrompt } from "../../shared/prompts";
import type { ApplicationDatabase } from "../infrastructure/database";
import type { ReferenceImageStore } from "../infrastructure/reference-image-store";
import { WorkspaceRepository } from "../infrastructure/workspace-repository";

const requestSchema = z.object({ taskId: z.string().uuid(), accountId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  selectedExtraAssetIds: z.array(z.string().uuid()).max(200), requiredExtraAssetIds: z.array(z.string().uuid()).max(200) }).strict();
/** Trusted internal adapter evidence, NOT caller/renderer input or manually marked Account flags.
 * No production verifier is implemented or connected by this module. The port must perform no
 * async/network work here; acquire verified evidence elsewhere and return its scoped snapshot. */
const evidenceSchema = z.object({ provider: z.literal("doubao"), accountId: z.string().uuid(),
  evidenceId: z.string().uuid(), observedAt: z.number().finite(), expiresAt: z.number().finite(),
  login: z.literal("verified"), charge: z.literal("verified-free"),
  roles: z.array(z.enum(["first", "last"])).max(2),
  aspectRatios: z.array(z.string().max(20)).max(20), durations: z.array(z.number().int().positive()).max(20) }).strict();
export type VideoCapabilityEvidence = z.infer<typeof evidenceSchema>;
export interface VideoCapabilityEvidencePort { read(accountId: string): unknown }
export type VideoPreflightInput = z.input<typeof requestSchema>;
export type VideoPreflightBlocker = "INVALID_REQUEST" | "EXTRA_ASSETS_UNCONFIRMED" | "ACCOUNT_BLOCKED" | "CAPABILITY_UNVERIFIED"
  | "TASK_CHANGED" | "CONFIRMATION_REQUIRED" | "IMAGE_UNAVAILABLE" | "UNSUPPORTED_INPUT" | "READ_FAILED";
const blocked = (reason: VideoPreflightBlocker) => Object.freeze({ status: "blocked" as const, reason, submitted: false as const });

/** Non-network, non-writing, point-in-time preflight ONLY. A seal is never permission to submit
 * later: a future sender must revalidate all inputs/evidence immediately before actual submission.
 * Image bytes are read and hashed internally, never exposed, copied, uploaded or retained. */
export class VideoPreflight {
  constructor(private readonly database: ApplicationDatabase, private readonly references: ReferenceImageStore,
    private readonly capabilities: VideoCapabilityEvidencePort, private readonly now: () => number = Date.now) {}

  check(raw: VideoPreflightInput) {
    let input: z.infer<typeof requestSchema>;
    try {
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) return blocked("INVALID_REQUEST");
      input = parsed.data;
    } catch { return blocked("INVALID_REQUEST"); }
    // There is no persisted user confirmation for additional assets in the current schema.
    if (input.selectedExtraAssetIds.length || input.requiredExtraAssetIds.length) return blocked("EXTRA_ASSETS_UNCONFIRMED");
    try {
      return this.database.transaction(() => {
        const db = this.database.connection;
        const account = db.prepare("SELECT a.enabled,r.state FROM accounts a JOIN account_removal r ON r.account_id=a.id WHERE a.id=?").get(input.accountId);
        if (!account || account.enabled !== 1 || account.state !== "present") return blocked("ACCOUNT_BLOCKED");
        const evidence = evidenceSchema.safeParse(this.capabilities.read(input.accountId));
        const now = this.now();
        if (!evidence.success || evidence.data.accountId !== input.accountId || !Number.isFinite(now)
          || evidence.data.observedAt > now || evidence.data.expiresAt <= now || evidence.data.expiresAt <= evidence.data.observedAt)
          return blocked("CAPABILITY_UNVERIFIED");
        const repository = new WorkspaceRepository(this.database), task = repository.getTask(input.taskId);
        if (task.revision !== input.expectedRevision) return blocked("TASK_CHANGED");
        const planRow = db.prepare("SELECT style,style_notes FROM plans WHERE id=?").get(task.planId);
        if (!planRow || !["comic", "realistic"].includes(String(planRow.style))) return blocked("READ_FAILED");
        const plan = { style: planRow.style as "comic" | "realistic", styleNotes: String(planRow.style_notes ?? "") };
        if (!hasCurrentConfirmation(task.workspace, plan)) return blocked("CONFIRMATION_REQUIRED");
        const parameters = task.workspace.frames!.parameters;
        if (!evidence.data.roles.includes("first") || !evidence.data.roles.includes("last")
          || !evidence.data.aspectRatios.includes(parameters.aspectRatio) || !evidence.data.durations.includes(parameters.durationSeconds)) return blocked("UNSUPPORTED_INPUT");
        const images = [];
        for (const role of ["first", "last"] as const) {
          const candidate = currentFrame(task.workspace, role)!;
          const row = db.prepare("SELECT task_id,content_hash FROM reference_images WHERE id=?").get(candidate.imageId);
          if (!row || row.task_id !== task.id) return blocked("IMAGE_UNAVAILABLE");
          const bytes = this.references.readVerifiedBytes(candidate.imageId);
          if (!bytes) return blocked("IMAGE_UNAVAILABLE");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          if (sha256 !== row.content_hash) return blocked("IMAGE_UNAVAILABLE");
          images.push(Object.freeze({ role, candidateId: candidate.id, imageId: candidate.imageId, sha256, byteLength: bytes.length }));
        }
        // Evidence may have expired during bounded local file reads. No future-validity claim.
        const finishedAt = this.now();
        if (!Number.isFinite(finishedAt) || finishedAt < now || finishedAt >= evidence.data.expiresAt) return blocked("CAPABILITY_UNVERIFIED");
        const video = findPrompt(task.workspace, "video", null)!;
        return Object.freeze({ status: "preflight-only" as const, submitted: false as const, taskId: task.id,
          taskRevision: task.revision, accountId: input.accountId, evidenceId: evidence.data.evidenceId,
          video: Object.freeze({ text: video.text, version: video.version, inputSnapshot: video.inputSnapshot }),
          confirmation: Object.freeze({ ...task.workspace.frames!.confirmation! }),
          parameters: Object.freeze({ ...parameters }), images: Object.freeze(images), extraAssets: Object.freeze([]) });
      });
    } catch { return blocked("READ_FAILED"); }
  }
}
