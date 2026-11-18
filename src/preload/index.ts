import { contextBridge, ipcRenderer } from "electron";
import { COMMAND_CHANNEL, type DesktopBridge } from "../shared/bridge";

const bridge: DesktopBridge = {
  invoke: (request) => ipcRenderer.invoke(COMMAND_CHANNEL, request),
};

contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));
