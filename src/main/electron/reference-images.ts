import { dialog, type BrowserWindow } from "electron";
import sharp from "sharp";
import { ReferenceImageStore } from "../infrastructure/reference-image-store";
import { ApplicationError } from "../core/errors";

export async function decodeReference(bytes: Buffer) {
  const image = sharp(bytes, { limitInputPixels: 40000000, animated: false });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192
    || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1)
    throw new Error("Unsupported static image");
  const result = await image.rotate().png().toBuffer({ resolveWithObject: true });
  return { width: result.info.width, height: result.info.height, png: result.data };
}

export function createReferenceImageGateway(store: ReferenceImageStore, getWindow: () => BrowserWindow | null) {
  let importing = false;
  return {
    isAvailable(imageId: string) { return store.isAvailable(imageId); },
    async importForTask(taskId: string) {
      if (importing) throw new ApplicationError("CONFLICT", "请先完成当前图片选择。");
      const window = getWindow();
      if (!window || window.isDestroyed()) throw new ApplicationError("NOT_FOUND", "工作区窗口已关闭。");
      importing = true;
      try {
        const result = await dialog.showOpenDialog(window, {
          title: "选择本地静态图片", properties: ["openFile"],
          filters: [{ name: "静态图片（PNG / JPG / WebP）", extensions: ["png", "jpg", "jpeg", "webp"] }],
        });
        return result.canceled || !result.filePaths[0] ? null : await store.importFile(taskId, result.filePaths[0]);
      } finally { importing = false; }
    },
  };
}
