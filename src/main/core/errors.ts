import type { ErrorCode } from "../../shared/bridge";

export class ApplicationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function normalizeError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const systemCode =
    error instanceof Error && "code" in error ? String(error.code) : "";
  if (
    error instanceof Error &&
    (/SQLITE|EACCES|EPERM|ENOSPC|EROFS/.test(systemCode) ||
      /sqlite|database|disk|readonly/i.test(error.message))
  ) {
    return new ApplicationError(
      "STORAGE_ERROR",
      "本地保存失败，请检查数据目录和可用空间后重试。",
    );
  }
  return new ApplicationError(
    "INTERNAL_ERROR",
    "操作没有完成，请重试并保留请求编号以便排查。",
  );
}
