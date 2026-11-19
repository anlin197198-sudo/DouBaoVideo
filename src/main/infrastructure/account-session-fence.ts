import type { SessionFence } from "../application/account-session-lifecycle";
import type { RemovalLease } from "../application/account-removal-workflow";
import type { ApplicationDatabase } from "./database";
/** A DB fence for synchronous local window actions, NOT global Electron session quiescence. */
export class SqliteAccountSessionFence implements SessionFence {
  constructor(private readonly getDatabase: () => ApplicationDatabase | null) {}
  private run<T>(check: (database: ApplicationDatabase) => void, action: () => T): T {
    const database = this.getDatabase();
    if (!database || !database.connection.isOpen) throw new Error("工作区数据库不可用，不能操作登录窗口。");
    return database.transaction(() => {
      check(database);
      const value = action();
      if (value instanceof Promise) throw new Error("登录窗口 fence 只允许同步操作。");
      return value;
    });
  }
  present<T>(accountId: string, action: () => T): T {
    return this.run(db => {
      const row = db.connection.prepare("SELECT state FROM account_removal WHERE account_id=?").get(accountId);
      if (!row || row.state !== "present") throw new Error("账号正在移除或已移除，不能打开登录窗口。");
    }, action);
  }
  removal<T>(lease: RemovalLease, action: () => T): T {
    if (!lease || [lease.accountId, lease.operationId, lease.leaseToken].some(value => typeof value !== "string" || !value.trim()))
      throw new Error("移除租约标识不完整，不能关闭账号窗口。");
    return this.run(db => {
      const row = db.connection.prepare("SELECT state,operation_id,lease_token FROM account_removal WHERE account_id=?").get(lease.accountId);
      if (!row || row.state !== "pending" || row.operation_id !== lease.operationId || row.lease_token !== lease.leaseToken)
        throw new Error("移除租约已变化，不能关闭此账号窗口。");
    }, action);
  }
}
