// Browser component smoke test. Compile with esbuild; see docs/F02-隔离恢复服务.md.
// No Electron, filesystem operations, or real user data: desktop bridge is synthetic.
import { createRoot } from "react-dom/client";
import { BackupPanel } from "../src/renderer/src/components/BackupPanel";
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const fixture = { directory: "/synthetic/new-isolated", databaseVersion: 5, taskCount: 7,
  imageCount: 2, totalBytes: 1024, filmRecordCount: 0, createdAt: "2026-11-19", isolated: true,
  workspaceActivated: false, videoFilesIncluded: false, notice: "Synthetic only" };
let calls = 0;
let finish: (value: unknown) => void;
let busy = false;
Object.defineProperty(window, "desktop", { value: { invoke: async (request: {command: string; input: unknown; requestId: string}) => {
  assert(request.command === "workspace.restoreBackup", "wrong command");
  assert(JSON.stringify(request.input) === "{}", "renderer sent filesystem input");
  calls++;
  const data = await new Promise(resolve => { finish = resolve; });
  return data === "error" ? {ok: false, requestId: request.requestId, error: {code:"STORAGE_ERROR",message:"synthetic failure"}}
    : {ok:true,requestId:request.requestId,data};
} }});
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
root.render(<BackupPanel onBusy={value => { busy = value; }} />);
const click = () => {
  const button = [...host.querySelectorAll("button")].find(node => node.textContent?.includes("恢复为隔离副本"));
  assert(button, "missing restore control"); button!.click();
};
(async () => {
  await pause(); click(); click(); await pause();
  assert(calls === 1 && busy, "repeated click not locked");
  assert([...host.querySelectorAll("button")].every(node => node.disabled), "busy controls enabled");
  const close = new Event("beforeunload", { cancelable:true }); window.dispatchEvent(close);
  assert(close.defaultPrevented, "busy unload not protected");
  finish(null); await pause();
  assert(!busy && host.textContent?.includes("已取消隔离恢复"), "cancel feedback/lock not reset");
  click(); await pause(); finish(fixture); await pause();
  assert(calls === 2 && !busy && host.textContent?.includes("/synthetic/new-isolated"), "success missing");
  assert(host.textContent?.includes("副本未激活"), "activation boundary missing");
  click(); await pause();
  assert(!host.textContent?.includes("/synthetic/new-isolated"), "stale result remains");
  finish("error"); await pause();
  assert(!busy && host.textContent?.includes("synthetic failure"), "error/lock not reset");
  click(); await pause(); finish(null); await pause();
  assert(calls === 4 && !busy, "retry after error failed");
  const idleClose = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(idleClose);
  assert(!idleClose.defaultPrevented, "idle unload incorrectly blocked");
  root.unmount();
  document.body.innerHTML = '<pre id="result">PASS: restore panel repeated click, busy controls, unload, cancel, success, stale clearing, failure and retry</pre>';
})().catch(error => { document.body.innerHTML = '<pre id="result">FAIL: '+ String(error) + '</pre>'; });
