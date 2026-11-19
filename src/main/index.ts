import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { app, BrowserWindow, dialog, protocol } from "electron";
import { storyboardApprovalOwner } from "./application/storyboard-dialog-owner";
import { createApplicationServices } from "./application/services";
import { DeepSeekPlanner, readDeepSeekPlannerOptions } from "./providers/deepseek-planner";
import { FileLogger } from "./core/logger";
import { ApplicationDatabase } from "./infrastructure/database";
import { createApplicationPaths } from "./infrastructure/paths";
import { SqliteAccountSessionFence } from "./infrastructure/account-session-fence";
import { AccountSessionManager } from "./electron/account-sessions";
import { registerCommandHandler, registerQueueIntentHandler } from "./electron/ipc";
import { registerApplicationProtocol } from "./electron/app-protocol";
import { ReferenceImageStore } from "./infrastructure/reference-image-store";
import { createReferenceImageGateway, decodeReference } from "./electron/reference-images";
import { WorkspaceBackup } from "./infrastructure/workspace-backup";
import { IsolatedRestore, validateRestorePreview } from "./infrastructure/isolated-restore";
import { RestoreBackupWorkflow } from "./application/restore-backup-workflow";
import { BackupValidation } from "./infrastructure/backup-validation";

import { DesktopLifecycle } from "./application/desktop-lifecycle";
import { createDesktopTray } from "./electron/tray";
import { QUEUE_REQUESTED_CHANNEL } from "../shared/bridge";

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
const storyboardDocumentEpoch = new WeakMap<BrowserWindow, number>();
const readStoryboardDocumentEpoch = (window: BrowserWindow) => storyboardDocumentEpoch.get(window) ?? 0;
const invalidateStoryboardDocument = (window: BrowserWindow) => storyboardDocumentEpoch.set(window, readStoryboardDocumentEpoch(window) + 1);
let database: ApplicationDatabase | null = null;
let workspaceReady = false;
const sessions = new AccountSessionManager(new SqliteAccountSessionFence(() => database));
const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? "app://renderer/";

const desktop = new DesktopLifecycle({
  window: () => mainWindow,
  createTray: createDesktopTray,
  createWindow: async () => { if (workspaceReady) await createMainWindow(); },
  openFailed: () => dialog.showErrorBox("工作区打开失败", "请重新启动 DouBaoVideo。"),
  signalQueue: () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send(QUEUE_REQUESTED_CHANNEL);
  },
  quit: () => app.quit(),
  cleanup: () => { try { sessions.closeAll(); } finally { database?.close(); database = null; } },
});

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    show: false,
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
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).href !== new URL(rendererUrl).href) event.preventDefault();
  });
  window.webContents.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) invalidateStoryboardDocument(window);
  });
  window.webContents.on("render-process-gone", () => { invalidateStoryboardDocument(window); });
  window.on("minimize", () => { desktop.minimize(); });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  try { await window.loadURL(rendererUrl); }
  catch (error) {
    // A failed first load has no editable workspace to protect. Do not retain a blank window.
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    desktop.open();
  });
  void app
    .whenReady()
    .then(async () => {
      const paths = createApplicationPaths(app.getPath("userData"));
      database = new ApplicationDatabase(paths.database);
      const referenceStore = new ReferenceImageStore(database, paths.media, decodeReference);
      const backups = new WorkspaceBackup({ database, mediaDirectory: paths.media, applicationVersion: app.getVersion(), decode: decodeReference,
        chooseDirectory: async () => {
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Workspace window is closed");
          const selection = await dialog.showOpenDialog(mainWindow, { title: "选择业务数据与静态图备份目录（不含视频/登录会话）", properties: ["openDirectory"] });
          return selection.canceled ? null : selection.filePaths[0] ?? null;
        } });
      const restore = new IsolatedRestore({ currentWorkspace: paths.dataDirectory, decode: decodeReference });
      function requireWindow() {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Workspace window is closed");
        return mainWindow;
      }
      const backupRestore = new RestoreBackupWorkflow({
        chooseSource: async () => {
          const selection = await dialog.showOpenDialog(requireWindow(), { title: "选择要隔离恢复的备份目录（含 manifest.json）", properties: ["openDirectory"] });
          return selection.canceled ? null : selection.filePaths[0] ?? null;
        },
        validate: source => validateRestorePreview(source, decodeReference),
        chooseDestination: async () => {
          const selection = await dialog.showOpenDialog(requireWindow(), { title: "选择隔离副本的父目录（将创建全新子目录，不覆盖）", properties: ["openDirectory"] });
          return selection.canceled ? null : selection.filePaths[0] ?? null;
        },
        confirm: async ({ source, destinationParent, validation }) => {
          const result = await dialog.showMessageBox(requireWindow(), {
            type: "warning", title: "确认创建隔离恢复副本", message: "仅复制到全新隔离目录，不切换当前工作区。",
            detail: `源备份：${source}\n目标父目录：${destinationParent}\n数据库 V${validation.databaseVersion}，${validation.taskCount} 个任务，${validation.imageCount} 张静态图。\n\n不会覆盖已有数据，也不会自动打开或启用副本。不包含视频文件、应用登录会话或应用凭据；业务文本中自行写入的秘密仍会复制。文件完整性不代表来源真实性或全部业务可用性。复制前会再次验证。`,
            buttons: ["创建隔离副本", "取消"], defaultId: 1, cancelId: 1, noLink: true,
          });
          requireWindow();
          return result.response === 0;
        },
        restore: (source, destinationParent, expectedManifestSha256) => { requireWindow(); return restore.restore(source, destinationParent, undefined, expectedManifestSha256); },
      });
      const services = createApplicationServices({
        database,
        logger: new FileLogger(paths.logs),
        sessions,
        version: app.getVersion(),
        dataDirectory: paths.dataDirectory,
        references: createReferenceImageGateway(referenceStore, () => mainWindow),
        backups,
        backupRestore,
        storyboardPlanner: new DeepSeekPlanner(readDeepSeekPlannerOptions()),
        confirmStoryboard: async ({ title, revision, scriptLength }) => {
          const window = requireWindow();
          const sameDocument = storyboardApprovalOwner(window, () => mainWindow, readStoryboardDocumentEpoch,
            owner => !owner.isDestroyed() && !owner.webContents.isDestroyed());
          const answer = await dialog.showMessageBox(window, {
            type: "warning", title: "确认发送剧本给 DeepSeek",
            message: "将当前已保存剧本正文发送给 DeepSeek 生成分镜候选？",
            detail: `任务：${title} · 保存修订 ${revision} · 正文 ${scriptLength} 字符。\n\n正文会发送到 DeepSeek 官方服务（api.deepseek.com），可能产生 API 费用。不会发送图片、项目文件或账号会话；返回内容仅供预览，不会覆盖当前镜头。`,
            buttons: ["确认发送", "取消"], defaultId: 1, cancelId: 1, noLink: true,
          });
          return answer.response === 0 && sameDocument();
        },
        backupValidation: new BackupValidation(async () => {
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Workspace window is closed");
          const selected = await dialog.showOpenDialog(mainWindow, { title: "选择要只读验证的备份目录（含 manifest.json）", properties: ["openDirectory"] });
          return selected.canceled ? null : selected.filePaths[0] ?? null;
        }, decodeReference),
      });
      registerApplicationProtocol(resolve(__dirname, "../renderer"), id => referenceStore.readVerifiedBytes(id));
      registerCommandHandler(services.router, () => mainWindow, rendererUrl);
      registerQueueIntentHandler(() => mainWindow, rendererUrl, (trusted, args) => desktop.consumeQueue(trusted, args));
      desktop.start();
      await createMainWindow();
      workspaceReady = true;
      desktop.open();
      app.on("activate", () => { desktop.open(); });
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
  app.on("will-quit", () => { desktop.willQuit(); });
}
