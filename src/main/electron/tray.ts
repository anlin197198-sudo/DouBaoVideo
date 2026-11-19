import { Menu, Tray, nativeImage } from "electron";
import type { DesktopActions } from "../application/desktop-lifecycle";

// Self-generated 16x16 RGBA geometric D icon; no remote or user asset.
const iconData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR4nGPQSjz+nxLMMAwNwAVINoBY8VEDaGkA2dE48CmR7gYAAOO9jSufVRb/AAAAAElFTkSuQmCC";
export function createDesktopTray(actions: DesktopActions): Tray {
  const icon = nativeImage.createFromDataURL(iconData);
  if (icon.isEmpty()) throw new Error("Tray icon unavailable");
  const tray = new Tray(icon);
  try {
    tray.setToolTip("DouBaoVideo（本地工作区，真实调度未接入）");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开主窗口", click: actions.open },
      { label: "查看任务队列", click: actions.queue },
      { type: "separator" },
      { label: "退出", click: actions.exit },
    ]));
    tray.on("double-click", actions.open);
    return tray;
  } catch (error) { tray.destroy(); throw error; }
}
