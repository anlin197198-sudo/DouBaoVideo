import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { COMMAND_CHANNEL, CONSUME_QUEUE_CHANNEL } from "../../shared/bridge";
import type { CommandRouter } from "../application/command-router";

export function isTrustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  rendererUrl: string,
): boolean {
  if (
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(rendererUrl);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

export function registerCommandHandler(
  router: CommandRouter,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
): void {
  ipcMain.handle(COMMAND_CHANNEL, (event, request: unknown) => {
    const window = getWindow();
    return router.dispatch(request, {
      trusted: window !== null && isTrustedSender(event, window, rendererUrl),
    });
  });
}

export function registerQueueIntentHandler(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  consume: (trusted: boolean, args: unknown[]) => boolean,
): void {
  ipcMain.handle(CONSUME_QUEUE_CHANNEL, (event, ...args: unknown[]) => {
    const window = getWindow();
    return consume(window !== null && isTrustedSender(event, window, rendererUrl), args);
  });
}
