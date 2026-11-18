import type {
  CommandInputs,
  CommandName,
  CommandOutputs,
  ErrorCode,
} from "../../../shared/bridge";

export class DesktopCommandError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly requestId: string,
  ) {
    super(message);
    this.name = "DesktopCommandError";
  }
}

export async function command<K extends CommandName>(
  name: K,
  input: CommandInputs[K],
  requestId = crypto.randomUUID(),
): Promise<CommandOutputs[K]> {
  if (!window.desktop) throw new Error("请通过桌面程序打开工作区。");
  const result = await window.desktop.invoke({
    requestId,
    command: name,
    input,
  });
  if (!result.ok)
    throw new DesktopCommandError(
      result.error.message,
      result.error.code,
      result.requestId,
    );
  return result.data;
}
