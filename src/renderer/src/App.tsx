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
import { AccountsPage } from "./pages/AccountsPage";
import { TaskCanvas } from "./pages/TaskCanvas";

type Page = "plans" | "accounts" | "queue" | "films";
const pages: { id: Page; label: string }[] = [
  { id: "plans", label: "周计划" },
  { id: "accounts", label: "账号管理" },
  { id: "queue", label: "任务队列" },
  { id: "films", label: "成片" },
];

export function App() {
  const [page, setPage] = useState<Page>("plans");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [info, setInfo] = useState<ApplicationInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [planView, setPlanView] = useState<{
    planId: string | null;
    day: number;
  }>({ planId: null, day: 0 });
  const selectedTask = snapshot?.tasks.find(
    (task) => task.id === selectedTaskId,
  );

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

  async function saveWorkspace(workspace: TaskWorkspace): Promise<boolean> {
    if (!selectedTask) return false;
    return perform(() =>
      command("tasks.saveWorkspace", {
        id: selectedTask.id,
        expectedRevision: selectedTask.revision,
        workspace,
      }),
    );
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
              busy={busy}
              onSave={saveWorkspace}
              onBack={() => setSelectedTaskId(null)}
            />
          ) : (
            <>
              {page === "plans" && (
                <PlansPage
                  plans={snapshot.plans}
                  tasks={snapshot.tasks}
                  busy={busy}
                  view={planView}
                  onViewChange={setPlanView}
                  onCreate={(input) =>
                    perform(() => command("plans.create", input))
                  }
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
              {page === "queue" && (
                <>
                  <div className="page-heading">
                    <h1>任务队列</h1>
                  </div>
                  <div className="empty">
                    <h2>等待接入真实生成任务</h2>
                    <p>
                      本地任务已保存。生成执行、账号派发和每日调度将在后续阶段接入。
                    </p>
                  </div>
                </>
              )}
              {page === "films" && (
                <>
                  <div className="page-heading">
                    <h1>成片</h1>
                  </div>
                  <div className="empty">
                    <h2>视频生成后，保存到这里</h2>
                    <p>真实成片下载与播放将在单任务生成阶段接入。</p>
                  </div>
                </>
              )}
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
        <Modal title="工作区信息" onClose={() => setShowInfo(false)}>
          <dl>
            <dt>数据库版本</dt>
            <dd>{info?.databaseVersion ?? "读取中"}</dd>
            <dt>本地数据目录</dt>
            <dd className="file-path">{info?.dataDirectory ?? "读取中"}</dd>
            <dt>豆包接入</dt>
            <dd>{info?.provider.message ?? "读取中"}</dd>
          </dl>
        </Modal>
      )}
    </div>
  );
}
