import { randomUUID } from "node:crypto";
import type { AccountRemovalStore, RemovalBegin, RemovalLease, RemovalSnapshot } from "../application/account-removal-workflow";
import { ApplicationError } from "../core/errors";
import { ApplicationDatabase } from "./database";

/** Persistent fencing only. No cleanup adapter/entry point is enabled by this store.
 * A crashed active lease deliberately cannot be reclaimed by time or a new process.
 * Future session cleanup must verify this lease and quiesce existing session handles.
 */
export class SqliteAccountRemovalStore implements AccountRemovalStore {
  constructor(private readonly database: ApplicationDatabase) {}
  private snapshot(accountId: string): RemovalSnapshot {
    const row = this.database.connection.prepare(`SELECT a.id,a.nickname,a.enabled,r.revision,r.state
      FROM accounts a JOIN account_removal r ON r.account_id=a.id WHERE a.id=?`).get(accountId);
    if (!row) throw new ApplicationError("NOT_FOUND", "账号不存在或移除状态缺失。");
    // Only the existing 'completed' status unambiguously denotes finished execution.
    // Failed/uncertain/unknown statuses can still require remote tracking; never assume terminal.
    const blockingExecutionIds = this.database.connection.prepare("SELECT id FROM executions WHERE account_id=? AND status!='completed' ORDER BY id")
      .all(accountId).map(value => String(value.id));
    return { accountId: String(row.id), nickname: String(row.nickname), enabled: Boolean(row.enabled),
      revision: Number(row.revision), state: row.state as RemovalSnapshot["state"], blockingExecutionIds };
  }
  async read(accountId: string): Promise<RemovalSnapshot> {
    return this.database.transaction(() => this.snapshot(accountId));
  }
  async begin(accountId: string, expectedRevision: number): Promise<RemovalBegin> {
    return this.database.transaction(() => {
      const snapshot = this.snapshot(accountId);
      if (snapshot.state === "removed") return { status: "removed" };
      const marker = this.database.connection.prepare("SELECT operation_id,lease_token FROM account_removal WHERE account_id=?").get(accountId)!;
      if (!Number.isSafeInteger(expectedRevision) || snapshot.revision !== expectedRevision || marker.lease_token !== null) return { status: "conflict" };
      if (snapshot.blockingExecutionIds.length) return { status: "blocked", blockingExecutionIds: snapshot.blockingExecutionIds };
      const lease = { accountId, operationId: marker.operation_id === null ? randomUUID() : String(marker.operation_id), leaseToken: randomUUID() };
      this.database.connection.prepare("UPDATE accounts SET enabled=0 WHERE id=?").run(accountId);
      this.database.connection.prepare("UPDATE account_removal SET state='pending',operation_id=?,lease_token=?,released_token=NULL,revision=revision+1 WHERE account_id=?")
        .run(lease.operationId, lease.leaseToken, accountId);
      return { status: "started", lease };
    });
  }
  private matched(lease: RemovalLease) {
    const marker = this.database.connection.prepare("SELECT * FROM account_removal WHERE account_id=?").get(lease.accountId);
    if (!marker || marker.operation_id !== lease.operationId || marker.lease_token !== lease.leaseToken)
      throw new ApplicationError("CONFLICT", "移除租约已变化，不能完成或释放其他操作。");
    return marker;
  }
  async complete(lease: RemovalLease): Promise<void> {
    this.database.transaction(() => {
      const marker = this.matched(lease);
      if (marker.state === "removed") return;
      if (marker.state !== "pending") throw new ApplicationError("CONFLICT", "账号不处于待移除状态。");
      this.database.connection.prepare("UPDATE account_removal SET state='removed',revision=revision+1 WHERE account_id=?").run(lease.accountId);
    });
  }
  async fail(lease: RemovalLease): Promise<void> {
    this.database.transaction(() => {
      const marker = this.database.connection.prepare("SELECT * FROM account_removal WHERE account_id=?").get(lease.accountId);
      // Repeating this failure release is safe only before any new fenced worker acquired it.
      if (marker?.state === "pending" && marker.operation_id === lease.operationId && marker.lease_token === null && marker.released_token === lease.leaseToken) return;
      const matched = this.matched(lease);
      if (matched.state === "removed") return;
      if (matched.state !== "pending") throw new ApplicationError("CONFLICT", "账号不处于待移除状态。");
      this.database.connection.prepare("UPDATE account_removal SET released_token=lease_token,lease_token=NULL,revision=revision+1 WHERE account_id=?").run(lease.accountId);
    });
  }
}
