import { DesktopCommandError } from "../api/client";

export function ErrorNotice({
  error,
  onDismiss,
  onRefresh,
}: {
  error: Error | null;
  onDismiss: () => void;
  onRefresh: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error-notice" role="alert">
      <div>
        <p>{error.message}</p>
        {error instanceof DesktopCommandError && (
          <small>请求编号 {error.requestId}</small>
        )}
      </div>
      <div>
        <button className="text-button" onClick={onRefresh}>
          刷新工作区
        </button>
        <button className="text-button" onClick={onDismiss}>
          关闭
        </button>
      </div>
    </div>
  );
}
