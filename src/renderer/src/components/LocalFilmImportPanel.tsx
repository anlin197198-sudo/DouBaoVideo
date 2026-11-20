import React, { useLayoutEffect, useState } from "react";
import type { VideoTask } from "../../../shared/models";
import { createLocalFilmImportState, type FilmImportState, type LocalFilmImportCapability } from "../pages/local-film-import-state";

type TaskChoice = Pick<VideoTask, "id" | "title" | "businessDate" | "revision">;

export function LocalFilmImportPanel({ tasks, capability }: {
  tasks: readonly TaskChoice[];
  capability: LocalFilmImportCapability;
}) {
  const [choice, setChoice] = useState("");
  const [state, setState] = useState<FilmImportState>({ busy: false, message: "" });
  const [controller] = useState(() => createLocalFilmImportState(setState));
  const task = tasks.find(entry => entry.id === choice);
  const id = task?.id, revision = task?.revision;
  // Commit the scope before user interaction or promise continuations can update this view.
  useLayoutEffect(() => {
    controller.setScope(id !== undefined && revision !== undefined ? { taskId: id, revision } : null, capability);
    return () => controller.setScope(null, undefined);
  }, [controller, id, revision, capability]);

  return <section className="review-notice" aria-label="导入本地成片">
    <h2>导入本地 MP4</h2>
    <p>所选文件只在本机处理，不上传或发起生成。接下来会选择文件和保存目录；写入前会由桌面应用另行确认。登记成功不代表可以播放。</p>
    {!tasks.length ? <p>暂无可选任务。</p> : <>
      <label>关联任务
        <select value={task ? choice : ""} disabled={state.busy}
          onChange={event => setChoice(event.currentTarget.value)}>
          <option value="">请选择当前工作区的任务</option>
          {tasks.map(entry => <option key={entry.id} value={entry.id}>{entry.title} · {entry.businessDate}</option>)}
        </select>
      </label>
      <button type="button" disabled={!task || state.busy} onClick={() => void controller.submit()}>
        {state.busy ? "正在处理本地导入…" : "选择 MP4 文件"}
      </button>
    </>}
    <p role="status" aria-live="polite">{state.message}</p>
  </section>;
}
