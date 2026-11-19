export type LocalExecutionRecoveryState = "queued" | "submitting" | "generating" | "uncertain" | "failed" | "completed" | "unknown";

/** The V1 execution table accepts arbitrary text; recovery explicitly does not expose it. */
export function localExecutionRecoveryState(value: unknown): LocalExecutionRecoveryState {
  switch (value) {
    case "queued": case "submitting": case "generating": case "uncertain": case "failed": case "completed":
      return value;
    default: return "unknown";
  }
}

export function localExecutionTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}

export function localExecutionRecoveryNotice(state: LocalExecutionRecoveryState, hasRecordedRemoteReference: boolean): { label: string; guidance: string } {
  switch (state) {
    case "queued": return { label: "本地排队记录", guidance: "仅保存为排队，不能据此判断是否已发送或自动执行。" };
    case "submitting": case "uncertain": return {
      label: "待核实原请求", guidance: "提交记录可能不完整，须先用原账号核实同一次请求，不要重新生成。",
    };
    case "generating": return hasRecordedRemoteReference
      ? { label: "记录为生成中", guidance: "本地留有定位信息，未核实远端进度；应先核实原请求，不要重新生成。" }
      : { label: "待核实原请求", guidance: "本地没有可见定位记录，不代表未提交；应先用原账号核实，不要重新生成。" };
    case "failed": return { label: "本地记录为失败", guidance: "尚未核实远端结果或失败步骤，不能据此重试。" };
    case "completed": return { label: "本地记录为完成", guidance: "此处只显示保存状态，不核验远端结果或成片文件。" };
    default: return { label: "需要核实", guidance: "本地状态无法识别，不能据此判断是否提交或重试。" };
  }
}
