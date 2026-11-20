import { FilmsPage } from "./pages/FilmsPage";
import { canOpenTrayQueue } from "../../shared/tray-navigation";
import type { PlanListView } from "../../shared/plan-list-view";
import { useEffect, useState } from "react";
import type {
  Account,
  ApplicationInfo,
  TaskWorkspace,
  VideoTask,
  WorkspaceSnapshot,
} from "../../shared/models";
import { command } from "./api/client";
import { ErrorNotice } from "./components/ErrorNotice";
import { Modal } from "./components/Modal";
import { PlansPage } from "./pages/PlansPage";
import { ExecutionRecoveryPage } from "./pages/ExecutionRecoveryPage";
import { AccountsPage } from "./pages/AccountsPage";
import { TaskCanvas } from "./pages/TaskCanvas";
import { BackupPanel } from "./components/BackupPanel";

type Page = "plans" | "accounts" | "queue" | "films";
const pages: { id: Page; label: string }[] = [
  { id: "plans", label: "周计划" },
  { id: "accounts", label: "账号管理" },
  { id: "queue", label: "任务队列" },
  { id: "films", label: "成片" },
];

export function App() {
  const [queueRequested, setQueueRequested] = useState(false);
  const [queueNotice, setQueueNotice] = useState("");
  useEffect(() => window.desktop?.onQueueRequested?.(() => { setQueueRequested(true); setQueueNotice(""); }), []);
  const [page, setPage] = useState<Page>("plans");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [info, setInfo] = useState<ApplicationInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [planView, setPlanView] = useState<PlanListView>({ planId: null, day: 0 });
  const selectedTask = snapshot?.tasks.find(
    (task) => task.id === selectedTaskId,
  );

  function openRequestedQueue() {
    if (!canOpenTrayQueue({ hasCanvas: selectedTaskId !== null, hasDialog: !!document.querySelector("dialog[open]"), busy: busy || backupBusy, ready: snapshot !== null })) {
      setQueueNotice("请先完成或关闭当前编辑，并等待保存完成；画布请通过返回按钮安全退出。");
      return;
    }
    setPage("queue"); setQueueRequested(false); setQueueNotice("");
  }

  async function reload() {
    const [workspace, application] = await Promise.all([
      command("workspace.read", {}),
      command("app.info", {}),
    ]);
    setSnapshot(workspace);
    setInfo(application);
  }

  useEffect(() => {
    void reload().catch((error) =>
      setError(error instanceof Error ? error : new Error("读取工作区失败。")),
    );
  }, []);

  async function perform(operation: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await operation();
      try {
        await reload();
      } catch {
        setError(new Error("操作已完成，读取最新页面失败。请刷新工作区。"));
      }
      return true;
    } catch (error) {
      setError(error instanceof Error ? error : new Error("操作没有完成。"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspace(workspace: TaskWorkspace, expectedRevision: number): Promise<VideoTask> {
    if (!selectedTask) throw new Error("任务已关闭，草稿尚未保存。");
    const saved = await command("tasks.saveWorkspace", { id: selectedTask.id, expectedRevision, workspace });
    // Background saves do not lock editing or reload unrelated state.
    setSnapshot(previous => previous ? { ...previous, tasks: previous.tasks.map(task => task.id === saved.id ? saved : task) } : previous);
    return saved;
  }

  return (
    <div className="application">
      <header className="application-header">
        <span className="brand">DouBaoVideo</span>
        <span className="separator">/</span>
        <span>
          {selectedTask
            ? selectedTask.title
            : pages.find((item) => item.id === page)?.label}
        </span>
        <button
          className="text-button info-button"
          onClick={() => setShowInfo(true)}
        >
          工作区信息
        </button>
      </header>
      {queueRequested && <section className="review-notice" role="status" aria-label="托盘队列请求">
        <p>托盘请求查看任务队列。当前页面和编辑保持不变；请先完成当前操作，再打开队列。调度与派发尚未接入。</p>
        <button className="text-button" disabled={busy || backupBusy || !!selectedTaskId || !snapshot} onClick={openRequestedQueue}>查看任务队列</button>
        <button className="text-button" onClick={() => { setQueueRequested(false); setQueueNotice(""); }}>取消请求</button>
        {selectedTaskId && <p className="helper">请先使用画布「返回」保存并退出，不会因托盘请求丢弃草稿。</p>}
        {queueNotice && <p>{queueNotice}</p>}
      </section>}
      <div className={"application-body" + (selectedTask ? " full-width" : "")}>
        {!selectedTask && (
          <aside className="sidebar">
            <nav aria-label="主导航">
              {pages.map((item) => (
                <button
                  key={item.id}
                  aria-current={item.id === page ? "page" : undefined}
                  onClick={() => setPage(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </aside>
        )}
        <main>
          <ErrorNotice
            error={error}
            onDismiss={() => setError(null)}
            onRefresh={() => {
              void reload()
                .then(() => setError(null))
                .catch(setError);
            }}
          />
          {!snapshot ? (
            <div className="empty">
              <p>正在读取本地工作区…</p>
              {error && (
                <button
                  className="text-button"
                  onClick={() => {
                    void reload()
                      .then(() => setError(null))
                      .catch(setError);
                  }}
                >
                  重新读取
                </button>
              )}
            </div>
          ) : selectedTask ? (
            <TaskCanvas
              key={selectedTask.id}
              task={selectedTask}
              planStyle={snapshot.plans.find(plan => plan.id === selectedTask.planId) ?? "realistic"}
              referenceImages={snapshot.referenceImages.filter(image => image.taskId === selectedTask.id)}
              busy={busy}
              onSave={saveWorkspace}
              onReadLatest={async () => {
                const latest = await command("workspace.read", {});
                const task = latest.tasks.find(item => item.id === selectedTask.id);
                if (!task) throw new Error("已保存任务不存在。请先复制保留本地草稿，不会自动放弃内容。");
                setSnapshot(previous => previous ? { ...previous,
                  plans: latest.plans,
                  tasks: previous.tasks.map(item => item.id === task.id ? task : item),
                  referenceImages: latest.referenceImages } : previous);
                return task;
              }}
              onConfirm={async () => {
                let confirmed: VideoTask | null = null;
                const completed = await perform(async () => { confirmed = await command("tasks.confirmFrames", {
                  id: selectedTask.id, expectedRevision: selectedTask.revision,
                }); });
                return completed ? confirmed : null;
              }}
              onBack={() => setSelectedTaskId(null)}
            />
          ) : (
            <>
              {page === "plans" && (
                <PlansPage
                  plans={snapshot.plans}
                  onReload={reload}
                  tasks={snapshot.tasks}
                  busy={busy}
                  view={planView}
                  onViewChange={setPlanView}
                  onCreate={async (input, requestId) => ({
                    planId: (await command("plans.create", input, requestId)).plan.id,
                  })}
                  onToggle={(plan) => {
                    void perform(() =>
                      command("plans.setEnabled", {
                        id: plan.id,
                        enabled: !plan.enabled,
                      }),
                    );
                  }}
                  onOpenTask={(task: VideoTask) => setSelectedTaskId(task.id)}
                />
              )}
              {page === "accounts" && (
                <AccountsPage
                  accounts={snapshot.accounts}
                  busy={busy}
                  onCreate={(nickname) =>
                    perform(() => command("accounts.create", { nickname }))
                  }
                  onUpdate={(account: Account) =>
                    perform(() =>
                      command("accounts.update", {
                        id: account.id,
                        nickname: account.nickname,
                        tier: account.tier,
                        enabled: account.enabled,
                      }),
                    )
                  }
                  onLogin={(id) => {
                    void perform(() => command("accounts.openLogin", { id }));
                  }}
                />
              )}
              {page === "queue" && <ExecutionRecoveryPage snapshot={snapshot} />}
              {page === "films" && <FilmsPage snapshot={snapshot} />}
            </>
          )}
        </main>
      </div>
      <footer className="application-footer">
        <span>
          {busy
            ? "正在处理…"
            : snapshot
              ? "本地工作区已连接"
              : "等待工作区连接"}
        </span>
        <span>桌面与数据基础 · v{info?.version ?? "0.1.0"}</span>
      </footer>
      {showInfo && (
        <Modal title="工作区信息" busy={backupBusy} onClose={() => setShowInfo(false)}>
          <dl>
            <dt>数据库版本</dt>
            <dd>{info?.databaseVersion ?? "读取中"}</dd>
            <dt>本地数据目录</dt>
            <dd className="file-path">{info?.dataDirectory ?? "读取中"}</dd>
            <dt>豆包接入</dt>
            <dd>{info?.provider.message ?? "读取中"}</dd>
          </dl>
          <BackupPanel onBusy={setBackupBusy} />
        </Modal>
      )}
    </div>
  );
}
