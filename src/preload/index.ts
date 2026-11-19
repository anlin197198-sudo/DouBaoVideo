import { contextBridge, ipcRenderer } from "electron";
import { COMMAND_CHANNEL, QUEUE_REQUESTED_CHANNEL, CONSUME_QUEUE_CHANNEL, type DesktopBridge } from "../shared/bridge";

import { createQueueSubscription } from "../shared/queue-subscription";

const bridge: DesktopBridge = {
  onQueueRequested: createQueueSubscription({
    listen: signal => { ipcRenderer.on(QUEUE_REQUESTED_CHANNEL, () => signal()); },
    consume: () => ipcRenderer.invoke(CONSUME_QUEUE_CHANNEL),
  }),
  invoke: (request) => ipcRenderer.invoke(COMMAND_CHANNEL, request),
};

contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));
