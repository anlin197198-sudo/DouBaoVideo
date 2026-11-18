import { useState, type FormEvent } from "react";
import type { Account, SubscriptionTier } from "../../../shared/models";
import { Modal } from "../components/Modal";

export const tierLabels: Record<SubscriptionTier, string> = {
  unknown: "待确认",
  free: "免费",
  standard: "标准",
  plus: "加强",
  premium: "高级",
};

export function AccountsPage({
  accounts,
  busy,
  onCreate,
  onUpdate,
  onLogin,
}: {
  accounts: Account[];
  busy: boolean;
  onCreate: (nickname: string) => Promise<boolean>;
  onUpdate: (account: Account) => Promise<boolean>;
  onLogin: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [filter, setFilter] = useState<SubscriptionTier | "all">("all");
  const rows = accounts.filter(
    (account) => filter === "all" || account.tier === filter,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nickname = String(data.get("nickname"));
    const saved = editing
      ? await onUpdate({
          ...editing,
          nickname,
          tier: data.get("tier") as SubscriptionTier,
          enabled: data.get("enabled") === "on",
        })
      : await onCreate(nickname);
    if (saved) {
      setCreating(false);
      setEditing(null);
    }
  }

  return (
    <>
      <div className="page-heading">
        <h1>账号管理</h1>
        <button className="primary" onClick={() => setCreating(true)}>
          添加账号
        </button>
      </div>
      <div className="filters">
        <label>
          订阅档位
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
          >
            <option value="all">全部</option>
            {Object.entries(tierLabels).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!accounts.length ? (
        <div className="empty">
          <h2>添加你的豆包账号</h2>
          <p>每个账号使用独立的本地登录会话。</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>档位</th>
              <th>当前情况</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((account) => (
              <tr key={account.id}>
                <td>
                  <button
                    className="title-button"
                    onClick={() => setEditing(account)}
                  >
                    {account.nickname}
                  </button>
                </td>
                <td>
                  {tierLabels[account.tier]}
                  {account.tierSource === "manual" && (
                    <small className="muted"> · 手动</small>
                  )}
                </td>
                <td className="muted">
                  {account.enabled ? "登录与免费状态待核实" : "已停用"}
                </td>
                <td>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => onLogin(account.id)}
                  >
                    打开豆包
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(creating || editing) && (
        <Modal
          title={editing ? "账号资料" : "添加账号"}
          busy={busy}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        >
          <form onSubmit={submit}>
            <label>
              账号昵称
              <input
                name="nickname"
                defaultValue={editing?.nickname ?? ""}
                required
                maxLength={120}
                autoFocus
              />
            </label>
            {editing && (
              <>
                <label>
                  订阅档位
                  <select name="tier" defaultValue={editing.tier}>
                    {Object.entries(tierLabels).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={editing.enabled}
                  />
                  启用这个账号
                </label>
                <p className="helper">
                  档位标注会保存到本地。登录和免费能力核实在后续接入。
                </p>
              </>
            )}
            <footer className="modal-actions">
              <button className="primary" disabled={busy}>
                {busy ? "正在保存…" : "保存账号"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
