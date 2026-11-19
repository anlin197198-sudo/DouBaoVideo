import type { Account } from "../../shared/models";
import type { RemovalLease } from "./account-removal-workflow";
export interface SessionWindow {
  isDestroyed(): boolean; destroy(): void; show(): void; focus(): void;
  onClosed(callback: () => void): void;
  load(): Promise<void>;
}
export interface SessionFence {
  /** Synchronous check AND action under the same DB write reservation. Never pass async work. */
  present<T>(accountId: string, action: () => T): T;
  removal<T>(lease: RemovalLease, action: () => T): T;
}
interface Entry { window: SessionWindow; ready: Promise<void>; loading: boolean; unusable: boolean }
/** Owns windows, not persistent sessions or network/service-worker lifetime. */
export class AccountSessionLifecycle {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly fence: SessionFence, private readonly create: (account: Account) => SessionWindow) {}
  open(account: Account): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("登录窗口管理器已关闭。"));
    try {
      return this.fence.present(account.id, () => {
        if (this.disposed) throw new Error("登录窗口管理器已关闭。");
        const existing = this.entries.get(account.id);
        if (existing && !existing.window.isDestroyed()) {
          if (existing.unusable) throw new Error("登录窗口未能验证关闭，不能重新打开。");
          if (!existing.loading) { existing.window.show(); existing.window.focus(); }
          return { ready: existing.ready };
        }
        const window = this.create(account);
        const entry: Entry = { window, loading: true, unusable: false, ready: Promise.resolve() };
        this.entries.set(account.id, entry);
        try {
          window.onClosed(() => { if (this.entries.get(account.id) === entry) this.entries.delete(account.id); });
          // Start navigation inside the fence; only waiting occurs outside the transaction.
          entry.ready = window.load().then(() => {
            this.fence.present(account.id, () => {
              if (this.disposed || this.entries.get(account.id) !== entry || window.isDestroyed()) throw new Error("登录窗口已关闭或失效。");
              entry.loading = false; window.show(); window.focus();
            });
          }).catch(error => { this.closeOwned(account.id, entry); throw error; });
        } catch (error) { this.closeOwned(account.id, entry); throw error; }
        return { ready: entry.ready };
      }).ready;
    } catch (error) { return Promise.reject(error); }
  }
  private closeOwned(accountId: string, entry: Entry): void {
    entry.unusable = true;
    if (!entry.window.isDestroyed()) entry.window.destroy();
    if (!entry.window.isDestroyed()) throw new Error("无法验证登录窗口已关闭。");
    if (this.entries.get(accountId) === entry) this.entries.delete(accountId);
  }
  closeForRemoval(lease: RemovalLease): { accountId: string; operationId: string; ownedWindowClosed: true; sessionCleared: false } {
    return this.fence.removal(lease, () => {
      const entry = this.entries.get(lease.accountId);
      if (entry) this.closeOwned(lease.accountId, entry);
      return { accountId: lease.accountId, operationId: lease.operationId, ownedWindowClosed: true, sessionCleared: false };
    });
  }
  closeAll(): void {
    this.disposed = true;
    let failed = false;
    for (const [id, entry] of this.entries) {
      try { this.closeOwned(id, entry); } catch { failed = true; }
    }
    if (failed) throw new Error("部分登录窗口未能验证关闭。");
  }
}
