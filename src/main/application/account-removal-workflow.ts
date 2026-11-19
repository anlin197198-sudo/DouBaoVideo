/** Coordination boundary only: no removal IPC/UI or Electron cleanup adapter is wired.
 * The SQLite store and existing-command gates are implemented separately. */
export interface RemovalSnapshot {
  accountId: string;
  nickname: string;
  revision: number;
  enabled: boolean;
  state: "present" | "pending" | "removed";
  /** Adapter must include active AND unknown/unclassified executions. Never infer terminal states here. */
  blockingExecutionIds: string[];
}
export interface RemovalLease { accountId: string; operationId: string; leaseToken: string }
export type RemovalBegin = { status: "blocked"; blockingExecutionIds: string[] }
  | { status: "conflict" } | { status: "removed" }
  | { status: "started"; lease: RemovalLease };
export interface AccountRemovalStore {
  read(accountId: string): Promise<RemovalSnapshot>;
  /**
   * One atomic transaction must reread revision and blocking executions, reject stale/blocked
   * requests, retain the account row and all task/film references, disable the account, persist
   * pending/tombstone intent and acquire an exclusive fenced lease. Existing pending retries
   * reuse operationId. Unknown statuses block. Concurrent processes must CAS/acquire here.
   * ALL login/edit-enable/dispatch writers must honor pending/removed and lease fencing.
   * None of these production guarantees is supplied by this standalone workflow.
   */
  begin(accountId: string, expectedRevision: number): Promise<RemovalBegin>;
  /** Atomic fenced CAS; mark removed without deleting identity/references; remain disabled.
   * Only called after verified cleanup. Must be idempotent for this operation/lease. */
  complete(lease: RemovalLease): Promise<void>;
  /** Release failed lease while retaining disabled pending intent. Never reenable or undo
   * an already committed removal if complete had an ambiguous failure. Must check fencing. */
  fail(lease: RemovalLease): Promise<void>;
}
export interface RemovalPreview { account: RemovalSnapshot; disclosure: string }
export type RemovalResult = { status: "cancelled" | "removed" }
  | { status: "blocked"; blockingExecutionIds: string[] }
  | { status: "pending"; stage: "cleanup" | "complete"; retryable: true; message: string };
export const REMOVAL_DISCLOSURE = "清理此账号在本机的登录会话并停用账号；保留账号原记录、任务和成片关联。不会删除远端账号或远端内容。正在执行或状态不明的任务会阻止清理。清理失败将保持停用和待清理状态，需要重试，不会自动重新启用。";

export class AccountRemovalWorkflow {
  private readonly running = new Set<string>();
  constructor(private readonly deps: {
    store: AccountRemovalStore;
    confirm(preview: RemovalPreview): Promise<boolean>;
    /** Adapter must close this account's handles, exclusively clear only its local session,
     * and verify absence before returning. Idempotent by operationId, fenced against stale
     * workers; a stale lease may not clear a newly-created session. No partition path input. */
    cleanup(lease: RemovalLease): Promise<{ accountId: string; operationId: string; verified: true }>;
  }) {}
  async run(accountId: string): Promise<RemovalResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) throw new Error("账号标识无效。");
    if (this.running.has(accountId)) throw new Error("此账号的移除流程正在进行。");
    this.running.add(accountId);
    try {
      const account = await this.deps.store.read(accountId);
      if (account.accountId !== accountId || !Number.isSafeInteger(account.revision) || account.revision < 0) throw new Error("账号移除预览不匹配。");
      if (account.state === "removed") return { status: "removed" };
      if (account.blockingExecutionIds.length) return { status: "blocked", blockingExecutionIds: [...account.blockingExecutionIds] };
      const revision = account.revision;
      if (!await this.deps.confirm({ account: structuredClone(account), disclosure: REMOVAL_DISCLOSURE })) return { status: "cancelled" };
      const begun = await this.deps.store.begin(accountId, revision);
      if (begun.status === "conflict") throw new Error("账号或执行状态已变化，请重新查看并确认。");
      if (begun.status === "blocked") return { status: "blocked", blockingExecutionIds: [...begun.blockingExecutionIds] };
      if (begun.status === "removed") return { status: "removed" };
      const lease = Object.freeze({ ...begun.lease });
      if (lease.accountId !== accountId || !lease.operationId || !lease.leaseToken) throw new Error("清理租约范围无效，未清理会话。");
      let stage: "cleanup" | "complete" = "cleanup";
      try {
        const cleaned = await this.deps.cleanup(lease);
        if (cleaned.accountId !== accountId || cleaned.operationId !== lease.operationId || cleaned.verified !== true) throw new Error("会话清理未通过范围与结果验证。");
        stage = "complete";
        await this.deps.store.complete(lease);
        return { status: "removed" };
      } catch {
        let released = true;
        try { await this.deps.store.fail(lease); } catch { released = false; }
        return { status: "pending", stage, retryable: true,
          message: released ? "未确认移除完成。账号保持停用，保留原记录，请重新检查并重试。"
            : "未确认移除完成且租约释放失败。账号必须保持停用，需适配器核实持久状态后重试。" };
      }
    } finally { this.running.delete(accountId); }
  }
}
