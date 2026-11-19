import type { PlanChangePreview } from "./plan-changes";
import type {
  Account,
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
  PromptKind, PromptHistorySummary, PromptHistoryDetail,
} from "./models";

export const COMMAND_CHANNEL = "doubao-video:command";

export interface CommandInputs {
  "app.info": Record<string, never>;
  "workspace.read": Record<string, never>;
  "workspace.backup": Record<string, never>;
  "workspace.verifyBackup": Record<string, never>;
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
  "tasks.confirmFrames": { id: string; expectedRevision: number };
  "prompts.historyList": { taskId: string; kind: PromptKind; shotId: string | null; beforeVersion?: number; limit?: number };
  "prompts.historyDetail": { taskId: string; kind: PromptKind; shotId: string | null; version: number };
}

export interface CommandOutputs {
  "app.info": ApplicationInfo;
  "workspace.read": WorkspaceSnapshot;
  "workspace.backup": BackupResult | null;
  "workspace.verifyBackup": BackupValidationResult | null;
  "plans.create": { plan: Plan; tasks: VideoTask[] };
  "plans.previewEdit": PlanChangePreview;
  "plans.applyEdit": { plan: Plan; tasks: VideoTask[] };
  "plans.setEnabled": Plan;
  "tasks.saveWorkspace": VideoTask;
  "accounts.create": Account;
  "accounts.update": Account;
  "accounts.openLogin": { opened: true };
  "assets.importReference": ReferenceImage | null;
  "tasks.confirmFrames": VideoTask;
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
  invoke<K extends CommandName>(
    request: CommandRequest<K>,
  ): Promise<CommandResult<CommandOutputs[K]>>;
}
