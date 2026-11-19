import type {ScriptReusePreview,ScriptReuseDraft} from "./script-reuse-draft";
import type { StoryboardPrefix } from "./storyboard-draft";
import type { StoryboardComparison } from "./storyboard-candidate";
import type { PlanChangePreview } from "./plan-changes";
import type {
  Account, StoryboardShot,
  ApplicationInfo,
  Plan,
  TaskWorkspace,
  VideoTask,
  VisualStyle,
  SubscriptionTier,
  WorkspaceSnapshot,
  ReferenceImage,
  BackupResult,
  BackupValidationResult,
  IsolatedRestoreResult,
  PromptKind, PromptHistorySummary, PromptHistoryDetail, ScriptHistorySummary, ScriptHistoryDetail,
} from "./models";

export const COMMAND_CHANNEL = "doubao-video:command";
export const QUEUE_REQUESTED_CHANNEL = "doubao-video:queue-requested";
export const CONSUME_QUEUE_CHANNEL = "doubao-video:consume-queue-intent";

export interface CommandInputs {
  "app.info": Record<string, never>;
  "workspace.read": Record<string, never>;
  "workspace.backup": Record<string, never>;
  "workspace.verifyBackup": Record<string, never>;
  "workspace.restoreBackup": Record<string, never>;
  "plans.create": {
    styleNotes?: string;
    title: string;
    style: VisualStyle;
    startDate: string;
    dailyCount: number;
    executionTime: string;
  };
  "plans.previewEdit": { id: string; changes: CommandInputs["plans.create"] };
  "plans.applyEdit": { id: string; changes: CommandInputs["plans.create"]; previewToken: string; removeTaskIds: string[] };
  "plans.setEnabled": { id: string; enabled: boolean };
  "tasks.saveWorkspace": {
    id: string;
    expectedRevision: number;
    workspace: TaskWorkspace;
  };
  "accounts.create": { nickname: string };
  "accounts.update": {
    id: string;
    nickname: string;
    tier: SubscriptionTier;
    enabled: boolean;
  };
  "accounts.openLogin": { id: string };
  "assets.importReference": { taskId: string };
  "storyboard.readiness": Record<string, never>;
  "storyboard.generatePreview": { taskId: string; expectedRevision: number };
  "storyboard.adoptDraft": { taskId: string; expectedRevision: number; token: string };
  "tasks.confirmFrames": { id: string; expectedRevision: number };
  "scripts.historyList": { taskId: string; beforeVersion?: number; limit?: number };
  "scripts.previewReuse": {taskId:string;expectedRevision:number;version:number};
  "scripts.applyReuse": {taskId:string;expectedRevision:number;token:string};
  "scripts.historyDetail": { taskId: string; version: number };
  "prompts.historyList": { taskId: string; kind: PromptKind; shotId: string | null; beforeVersion?: number; limit?: number };
  "prompts.historyDetail": { taskId: string; kind: PromptKind; shotId: string | null; version: number };
}

export interface CommandOutputs {
  "app.info": ApplicationInfo;
  "workspace.read": WorkspaceSnapshot;
  "workspace.backup": BackupResult | null;
  "workspace.verifyBackup": BackupValidationResult | null;
  "workspace.restoreBackup": IsolatedRestoreResult | null;
  "plans.create": { plan: Plan; tasks: VideoTask[] };
  "plans.previewEdit": PlanChangePreview;
  "plans.applyEdit": { plan: Plan; tasks: VideoTask[] };
  "plans.setEnabled": Plan;
  "tasks.saveWorkspace": VideoTask;
  "accounts.create": Account;
  "accounts.update": Account;
  "accounts.openLogin": { opened: true };
  "assets.importReference": ReferenceImage | null;
  "storyboard.readiness": { state: "disabled" | "missing_key" | "configuration_present" };
  "storyboard.generatePreview": { status: "cancelled" } | { status: "ready"; revision: number; preview: StoryboardComparison; adoptionToken: string | null };
  "storyboard.adoptDraft": { taskId: string; revision: number; prefix: StoryboardPrefix; shots: StoryboardShot[] };
  "tasks.confirmFrames": VideoTask;
  "scripts.historyList": { items: ScriptHistorySummary[]; nextBeforeVersion: number | null };
  "scripts.historyDetail": ScriptHistoryDetail;
  "scripts.previewReuse": ScriptReusePreview;
  "scripts.applyReuse": ScriptReuseDraft;
  "prompts.historyList": { items: PromptHistorySummary[]; nextBeforeVersion: number | null };
  "prompts.historyDetail": PromptHistoryDetail;
}

export type CommandName = keyof CommandInputs;
export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STORAGE_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type CommandResult<T> =
  | { ok: true; data: T; requestId: string }
  | {
      ok: false;
      error: { code: ErrorCode; message: string };
      requestId: string;
    };

export interface CommandRequest<K extends CommandName = CommandName> {
  requestId: string;
  command: K;
  input: CommandInputs[K];
}

export interface DesktopBridge {
  onQueueRequested?(callback: () => void): () => void;
  invoke<K extends CommandName>(
    request: CommandRequest<K>,
  ): Promise<CommandResult<CommandOutputs[K]>>;
}
