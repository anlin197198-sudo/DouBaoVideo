import React from "react";
import { localExecutionRecoveryNotice } from "../../../shared/execution-recovery";
import type { WorkspaceSnapshot } from "../../../shared/models";

function Time({ at }: { at: string | null }) {
  return at ? <time dateTime={at}>{new Date(at).toLocaleString()}</time> : <span>未记录</span>;
}

export function ExecutionRecoveryPage({ snapshot }: { snapshot: Pick<WorkspaceSnapshot, "executions" | "tasks" | "accounts"> }) {
  const tasks = new Map(snapshot.tasks.map(item => [item.id, item.title]));
  const accounts = new Map(snapshot.accounts.map(item => [item.id, item.nickname]));
  return <>
    <div className="page-heading"><h1>任务队列</h1></div>
    {!snapshot.executions.length ? <div className="empty">
      <h2>暂无本地执行记录</h2>
      <p>真实生成提交、账号派发和每日调度尚未接入。</p>
    </div> : <>
      <p className="helper">只读查看本地保存的执行记录；不会联网核实、发起生成或重试。</p>
      <table>
        <caption>本地执行记录</caption>
        <thead><tr><th scope="col">任务</th><th scope="col">记录账号</th><th scope="col">本地记录时间</th><th scope="col">状态与核实提示</th></tr></thead>
        <tbody>{snapshot.executions.map(row => {
          const notice = localExecutionRecoveryNotice(row.status, row.hasRecordedRemoteReference);
          return <tr key={row.id}>
            <td>{tasks.get(row.taskId) || "原任务不可用"}</td>
            <td>{row.accountId === null ? "未记录账号" : accounts.get(row.accountId) || "原账号不可用"}</td>
            <td><div>创建 <Time at={row.createdAt} /></div><div>更新 <Time at={row.updatedAt} /></div></td>
            <td><strong>{notice.label}</strong><p>{notice.guidance}</p></td>
          </tr>;
        })}</tbody>
      </table>
    </>}
  </>;
}
