import { dialog, type BrowserWindow } from "electron";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createMp4DialogWorkflow } from "../application/mp4-dialog-workflow";
import { intakeMp4 } from "../infrastructure/mp4-intake";

type Ports = Parameters<typeof createMp4DialogWorkflow<BrowserWindow>>[0];

/** Internal only. Connect a trusted inspection consumer and editor-context fence before use. */
export function createNativeMp4Dialog(options: Pick<Ports, "window" | "epoch" | "current" | "inspect">) {
  return createMp4DialogWorkflow({
    ...options,
    live: window => !window.isDestroyed() && !window.webContents.isDestroyed(),
    select: window => dialog.showOpenDialog(window, {
      title: "选择本地 MP4 文件",
      properties: ["openFile"],
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    }),
    async snapshot(path) {
      if (!isAbsolute(path) || resolve(path) !== path) throw new Error("选择的文件路径无效。");
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("选择的文件不是普通 MP4 文件。");
      const { dev, ino, size, mtimeMs, ctimeMs } = stat;
      return Object.freeze({ dev, ino, size, mtimeMs, ctimeMs });
    },
    intake: intakeMp4,
  });
}
