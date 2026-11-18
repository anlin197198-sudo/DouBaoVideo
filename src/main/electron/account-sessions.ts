import { BrowserWindow, session } from "electron";
import type { Account } from "../../shared/models";
import type { SessionGateway } from "../application/services";

export class AccountSessionManager implements SessionGateway {
  private readonly windows = new Map<string, BrowserWindow>();

  async open(account: Account): Promise<void> {
    const existing = this.windows.get(account.id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const accountSession = session.fromPartition(
      `persist:doubao-account-${account.id}`,
    );
    accountSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    const window = new BrowserWindow({
      title: `豆包 · ${account.nickname}`,
      width: 1080,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: {
        session: accountSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.windows.set(account.id, window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => this.windows.delete(account.id));
    try {
      await window.loadURL("https://www.doubao.com/");
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  closeAll(): void {
    for (const window of this.windows.values())
      if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
