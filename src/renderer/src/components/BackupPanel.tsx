import { useEffect, useRef, useState } from "react";
import type { BackupResult, BackupValidationResult, IsolatedRestoreResult } from "../../../shared/models";
import { command } from "../api/client";

export function BackupPanel({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [verified, setVerified] = useState<BackupValidationResult | null>(null);
  const [restored, setRestored] = useState<IsolatedRestoreResult | null>(null);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!lock.current) return;
      event.preventDefault(); event.returnValue = "备份或恢复正在进行，请完成后关闭。";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  async function create() {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setMessage(""); setResult(null); setVerified(null); setRestored(null);
    try {
      const saved = await command("workspace.backup", {});
      setResult(saved);
      if (!saved) setMessage("已取消选择，未创建备份。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "备份失败，请检查目标目录和图片。"); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  async function verify() {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setMessage(""); setResult(null); setVerified(null); setRestored(null);
    try {
      const checked = await command("workspace.verifyBackup", {});
      setVerified(checked);
      if (!checked) setMessage("已取消验证，未修改任何备份或工作区。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "备份验证失败。"); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  async function restore() {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setMessage(""); setResult(null); setVerified(null); setRestored(null);
    try {
      const copied = await command("workspace.restoreBackup", {});
      setRestored(copied);
      if (!copied) setMessage("已取消隔离恢复，未创建恢复副本，当前工作区未改变。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "隔离恢复失败，请检查来源与目标目录；当前工作区未切换。"); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  return <section aria-label="业务数据与静态图备份">
    <h3>业务数据与静态图备份</h3>
    <p className="helper">仅备份已保存的业务数据库与归档静态图片，不含视频文件、未保存草稿、应用登录会话、cookies、应用密码与凭据或浏览器资料。业务文本中自行写入的秘密仍会随数据库备份，请妥善保管。不上传，不覆盖旧备份；可将可信备份恢复到全新隔离副本，但不会覆盖或切换当前工作区。</p>
    <button className="primary" disabled={busy} onClick={() => void create()}>{busy ? "正在处理并校验，请勿退出…" : "选择本机目录并创建备份"}</button>
    <button className="text-button" disabled={busy} onClick={() => void verify()}>验证已有备份（只读）</button>
    <button className="text-button" disabled={busy} onClick={() => void restore()}>恢复为隔离副本…</button>
    <p className="helper">恢复会依次选择备份来源与可信目标父目录，确认后才写入全新随机子目录。可在选择或确认时取消；复制开始后请等待完成。副本不会自动打开，不含视频文件或登录会话。</p>
    {restored && <div role="status"><p>隔离副本已创建并复验：数据库 V{restored.databaseVersion}，{restored.taskCount} 条任务，{restored.imageCount} 张静态图。</p>
      <p className="file-path">{restored.directory}</p>
      <p className="helper">当前工作区未改变，副本未激活；数据库保持原版本。完整性校验不证明来源可信，也不代表全部业务数据已经可用。请保留原备份，不要手动覆盖当前工作区。</p>
    </div>}
    {message && <p role="status">{message}</p>}
    {result && <div role="status"><p>备份已创建并校验：数据库版本 {result.databaseVersion}，{result.imageCount} 张静态图，约 {(result.totalBytes / 1024 / 1024).toFixed(2)} MB。</p>
      <p className="file-path">{result.directory}</p>
      <p className="helper">包含 {result.filmRecordCount} 条成片元数据，但不包含视频文件。清单与 SHA-256 校验值在 manifest.json；恢复前仍需专门验证，勿直接覆盖当前工作区。</p>
    </div>}
    {verified && <div role="status"><p>文件完整性验证通过（含任务内容格式及图片引用检查）：数据库 V{verified.databaseVersion}，{verified.taskCount} 条任务，{verified.imageCount} 张静态图。</p>
      <p className="file-path">{verified.directory}</p><p className="helper">仅验证所选备份，没有恢复或覆盖任何工作区。数据库在临时隔离副本中只读检查，原备份未写入。校验不证明备份来源真实可信，清单与文件可被一起篡改。视频文件和应用登录会话不在此范围内。</p></div>}
  </section>;
}
