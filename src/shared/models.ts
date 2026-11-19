import type { LocalExecutionRecoveryState } from "./execution-recovery";
export type SubscriptionTier =
  | "unknown"
  | "free"
  | "standard"
  | "plus"
  | "premium";
export type VisualStyle = "realistic" | "comic";
export type CapabilityState = "unknown" | "available" | "exhausted";

export interface Account {
  id: string;
  nickname: string;
  tier: SubscriptionTier;
  tierSource: "unknown" | "manual" | "official";
  enabled: boolean;
  loginState: "unknown" | "signed_out" | "signed_in" | "verification_required";
  imageCapability: CapabilityState;
  videoCapability: CapabilityState;
  createdAt: string;
}

export interface Plan {
  styleNotes?: string;
  revision?: number;
  id: string;
  title: string;
  style: VisualStyle;
  startDate: string;
  dailyCount: number;
  executionTime: string;
  enabled: boolean;
  createdAt: string;
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface StoryboardShot {
  id: string;
  title: string;
  description: string;
  action: string;
  shotSize: string;
  cameraMovement: string;
  audio: string;
  position: CanvasPosition;
  needsReview: boolean;
  assetsNeedReview?: boolean;
}

export type AssetType = "person" | "scene" | "prop";

export interface ProductionAsset {
  id: string;
  type: AssetType;
  name: string;
  description: string;
  referenceImageId: string | null;
  version: number;
  position: CanvasPosition;
  needsReview: boolean;
}

export interface ReferenceImage {
  id: string;
  taskId: string;
  originalName: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface TaskWorkspace {
  /** View-only coordinates for prompt and frame nodes; absent in legacy workspaces. */
  productionPositions?: Record<string, CanvasPosition>;
  frames?: FrameWorkspace;
  promptSettings?: { style: VisualStyle | null; notes: string; notesMode?: "inherit" | "override" };
  prompts?: ProductionPrompt[];
  script: string;
  viewport: { x: number; y: number; zoom: number };
  scriptPosition: CanvasPosition;
  /** Array order is the narrative order; canvas coordinates do not change it. */
  shots: StoryboardShot[];
  assets: ProductionAsset[];
  /** One canonical relation set shared by checkboxes and canvas connections. */
  assetLinks: { shotId: string; assetId: string }[];
}

export type FrameSlot = "first" | "last";
export interface FrameCandidate {
  id: string;
  imageId: string;
  slot: FrameSlot;
  source: "import";
  createdAt: string;
  promptText: string;
  promptVersion: number | null;
  inputSnapshot: string;
}
export interface FrameWorkspace {
  candidates: FrameCandidate[];
  firstId: string | null;
  lastId: string | null;
  parameters: { aspectRatio: "16:9" | "9:16" | "1:1"; durationSeconds: 5 | 10 };
  confirmation: { inputSnapshot: string; confirmedAt: string; invalidated: boolean } | null;
}

export type PromptKind = "shot" | "video" | "firstFrame" | "lastFrame";
export interface ProductionPrompt {
  kind: PromptKind;
  shotId: string | null;
  text: string;
  version: number;
  /** Exact local input snapshot reviewed by the editor, not a generated result. */
  inputSnapshot: string;
  source: "manual";
}

export interface PromptHistorySummary {
  version: number; recordedAt: string; recordType: "baseline" | "saved";
  textLength: number; inputLength: number;
}
export interface PromptHistoryDetail extends PromptHistorySummary {
  text: string; inputSnapshot: string;
}

export interface VideoTask {
  scheduleActive?: boolean;
  executionTime?: string;
  id: string;
  planId: string;
  title: string;
  businessDate: string;
  sequence: number;
  status: "draft" | "review_required" | "scheduled" | "completed";
  revision: number;
  workspace: TaskWorkspace;
  updatedAt: string;
}

export interface Execution {
  id: string;
  taskId: string;
  status: LocalExecutionRecoveryState;
  accountId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  hasRecordedRemoteReference: boolean;
}

export interface Film {
  id: string;
  taskId: string;
  version: number | null;
  createdAt: string | null;
}

export interface WorkspaceSnapshot {
  plans: Plan[];
  tasks: VideoTask[];
  accounts: Account[];
  executions: Execution[];
  films: Film[];
  referenceImages: ReferenceImage[];
}

export interface ApplicationInfo {
  version: string;
  databaseVersion: number;
  dataDirectory: string;
  provider: { id: "doubao"; state: "unverified"; message: string };
}

export interface BackupResult {
  directory: string; createdAt: string; databaseVersion: number;
  imageCount: number; totalBytes: number; filmRecordCount: number;
}

export interface BackupValidationResult extends BackupResult {
  taskCount: number;
}

export interface IsolatedRestoreResult extends BackupValidationResult {
  isolated: true; workspaceActivated: false; videoFilesIncluded: false; notice: string;
}

export interface ScriptHistorySummary { version: number; recordedAt: string; recordType: "baseline" | "saved"; textLength: number }
export interface ScriptHistoryDetail extends ScriptHistorySummary { text: string }
