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

export interface TaskWorkspace {
  script: string;
  viewport: { x: number; y: number; zoom: number };
  scriptPosition: CanvasPosition;
}

export interface VideoTask {
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
  status: string;
  accountId: string | null;
  createdAt: string;
}

export interface Film {
  id: string;
  taskId: string;
  filePath: string;
  version: number;
}

export interface WorkspaceSnapshot {
  plans: Plan[];
  tasks: VideoTask[];
  accounts: Account[];
  executions: Execution[];
  films: Film[];
}

export interface ApplicationInfo {
  version: string;
  databaseVersion: number;
  dataDirectory: string;
  provider: { id: "doubao"; state: "unverified"; message: string };
}
