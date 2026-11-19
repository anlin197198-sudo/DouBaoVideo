import { BrowserWindow, session } from "electron";
import type { Account } from "../../shared/models";
import type { SessionGateway } from "../application/services";
import type { RemovalLease } from "../application/account-removal-workflow";
import { AccountSessionLifecycle, type SessionFence } from "../application/account-session-lifecycle";

export class AccountSessionManager implements SessionGateway {
  private readonly lifecycle: AccountSessionLifecycle;
  constructor(fence: SessionFence) {
    this.lifecycle = new AccountSessionLifecycle(fence, account => {
      const accountSession = session.fromPartition(`persist:doubao-account-${account.id}`);
      accountSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const window = new BrowserWindow({
        title: `豆包 · ${account.nickname}`, width: 1080, height: 800, show: false, autoHideMenuBar: true,
        webPreferences: { session: accountSession, nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      return {
        isDestroyed: () => window.isDestroyed(), destroy: () => window.destroy(),
        show: () => window.show(), focus: () => window.focus(),
        onClosed: callback => { window.on("closed", callback); },
        load: () => window.loadURL("https://www.doubao.com/"),
      };
    });
  }
  open(account: Account): Promise<void> { return this.lifecycle.open(account); }
  /** Prerequisite only; never claims cookies/files/network activity have been cleared. */
  closeForRemoval(lease: RemovalLease) { return this.lifecycle.closeForRemoval(lease); }
  closeAll(): void { this.lifecycle.closeAll(); }
}
