import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { app, BrowserWindow, dialog, protocol } from "electron";
import { createApplicationServices } from "./application/services";
import { FileLogger } from "./core/logger";
import { ApplicationDatabase } from "./infrastructure/database";
import { createApplicationPaths } from "./infrastructure/paths";
import { AccountSessionManager } from "./electron/account-sessions";
import { registerCommandHandler } from "./electron/ipc";
import { registerApplicationProtocol } from "./electron/app-protocol";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

if (process.env.DOUBAO_DATA_DIR) {
  const dataDirectory = resolve(process.env.DOUBAO_DATA_DIR);
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath("userData", dataDirectory);
}

let mainWindow: BrowserWindow | null = null;
let database: ApplicationDatabase | null = null;
const sessions = new AccountSessionManager();
const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? "app://renderer/";

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: "DouBaoVideo",
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 580,
    autoHideMenuBar: true,
    backgroundColor: "#f7f8f7",
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).href !== new URL(rendererUrl).href) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(rendererUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      const paths = createApplicationPaths(app.getPath("userData"));
      database = new ApplicationDatabase(paths.database);
      const services = createApplicationServices({
        database,
        logger: new FileLogger(paths.logs),
        sessions,
        version: app.getVersion(),
        dataDirectory: paths.dataDirectory,
      });
      registerApplicationProtocol(resolve(__dirname, "../renderer"));
      registerCommandHandler(services.router, () => mainWindow, rendererUrl);
      await createMainWindow();
      app.on("activate", () => {
        if (!mainWindow)
          void createMainWindow().catch(() =>
            dialog.showErrorBox("工作区打开失败", "请重新启动 DouBaoVideo。"),
          );
      });
    })
    .catch((error) => {
      dialog.showErrorBox(
        "DouBaoVideo 启动失败",
        error instanceof Error ? error.message : "无法初始化本地工作区。",
      );
      app.quit();
    });
  app.on("window-all-closed", () => {
    app.quit();
  });
  app.on("before-quit", () => {
    sessions.closeAll();
  });
  app.on("will-quit", () => {
    database?.close();
  });
}
