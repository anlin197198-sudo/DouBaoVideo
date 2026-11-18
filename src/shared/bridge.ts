import type {
  Account,
  ApplicationInfo,
  Plan,
  TaskWorkspace,
  VideoTask,
  VisualStyle,
  SubscriptionTier,
  WorkspaceSnapshot,
} from "./models";

export const COMMAND_CHANNEL = "doubao-video:command";

export interface CommandInputs {
  "app.info": Record<string, never>;
  "workspace.read": Record<string, never>;
  "plans.create": {
    title: string;
    style: VisualStyle;
    startDate: string;
    dailyCount: number;
    executionTime: string;
  };
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
}

export interface CommandOutputs {
  "app.info": ApplicationInfo;
  "workspace.read": WorkspaceSnapshot;
  "plans.create": { plan: Plan; tasks: VideoTask[] };
  "plans.setEnabled": Plan;
  "tasks.saveWorkspace": VideoTask;
  "accounts.create": Account;
  "accounts.update": Account;
  "accounts.openLogin": { opened: true };
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
