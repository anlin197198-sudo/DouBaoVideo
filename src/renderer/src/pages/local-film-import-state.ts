import type { LocalImportCommandResult, LocalImportRequest } from "../../../main/application/local-import-command";

export type LocalFilmImportCapability = Readonly<{
  run(request: Readonly<LocalImportRequest>, signal: AbortSignal): Promise<Readonly<LocalImportCommandResult>>;
  /** Refresh only film metadata; do not apply changes after the signal is aborted. */
  refreshRecords(signal: AbortSignal): Promise<void>;
}>;
export type FilmImportNotice = Readonly<{ message: string; refresh: boolean }>;
const unconfirmed: FilmImportNotice = Object.freeze({
  message: "无法确认本次导入结果。请先核对成片记录和所选目录，不要重复提交。", refresh: false,
});
const entry = (message: string, refresh = false): FilmImportNotice => Object.freeze({ message, refresh });

/** Only fixed text leaves this mapping. Durable facts take priority over window/task status. */
export function localFilmImportNotice(result: Readonly<LocalImportCommandResult>): FilmImportNotice {
  if (result.recordStatus === "recorded" || result.recordStatus === "prior-recorded") {
    const msg = result.recordStatus === "recorded" ? "已登记本地成片记录。" : "已有对应的本地成片记录。";
    return entry(msg + (!result.cleanupConfirmed || result.status === "cleanup-unconfirmed"
      ? " 临时清理尚未确认。此记录不代表可以播放。"
      : " 此记录不代表可以播放。"), true);
  }
  if (result.archiveStatus === "published" || result.archiveStatus === "published-cleanup-failed")
    return entry("文件已保存，但成片登记尚未确认。" + (result.archiveStatus === "published-cleanup-failed" || !result.cleanupConfirmed
      ? " 临时清理尚未确认。" : "") + " 请核对所选目录和记录，不要重复提交。");
  if (result.archiveStatus === "publication-uncertain" || result.recordStatus === "recording-unconfirmed"
    || !result.cleanupConfirmed || result.status === "cleanup-unconfirmed") return unconfirmed;
  if (result.archiveStatus !== "none" && result.archiveStatus !== "not-published") return unconfirmed;
  if (result.recordStatus !== "none") return unconfirmed;
  switch (result.status) {
    case "destination-unsupported": return entry("所选保存目录不支持安全的独占保存。未启动视频归档，请核对目录，不要自动重试。");
    case "cancelled": return entry("已取消。未确认有新增成片记录。");
    case "busy": return entry("另一项本地导入仍在处理，请先等待其结果。");
    case "stale": return entry("任务或页面状态已变化。请核对成片记录，再决定是否继续。");
    case "invalid-request": return entry("所选任务状态不受支持。请刷新工作区核对。");
    default: return unconfirmed;
  }
}

export type FilmImportState = Readonly<{ busy: boolean; message: string }>;
/** Single in-flight renderer operation. Changing scope aborts the request if supported and detaches its status.
 * The main command can still have persisted durable facts; never publish 'not saved' on scope loss. */
export function createLocalFilmImportState(emit: (state: FilmImportState) => void) {
  let scope: Readonly<LocalImportRequest> | null = null;
  let capability: LocalFilmImportCapability | undefined;
  let active: AbortController | undefined;
  let epoch = 0, message = "";
  const publish = () => { if (capability) emit({ busy: !!active, message }); };
  return {
    setScope(next: Readonly<LocalImportRequest> | null, handler: LocalFilmImportCapability | undefined) {
      if (scope?.taskId === next?.taskId && scope?.revision === next?.revision && capability === handler) return;
      epoch++;
      scope = next ? Object.freeze({ ...next }) : null;
      capability = handler;
      message = "";
      active?.abort();
      publish();
    },
    async submit() {
      if (!scope || !capability || active) return;
      const binding = scope, handler = capability, requested = epoch, abort = new AbortController();
      const current = () => requested === epoch && !abort.signal.aborted;
      active = abort;
      message = "";
      publish();
      try {
        const result = await handler.run(binding, abort.signal);
        if (!current()) return;
        const notice = localFilmImportNotice(result);
        message = notice.message;
        publish();
        if (notice.refresh) {
          try { await handler.refreshRecords(abort.signal); }
          catch {
            if (current()) message += " 最新记录未能刷新，请重新查看工作区核对。";
          }
        }
      } catch {
        if (current()) message = unconfirmed.message;
      } finally {
        active = undefined;
        publish();
      }
    },
  };
}
