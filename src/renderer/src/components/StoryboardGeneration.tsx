import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommandOutputs } from "../../../shared/bridge";
import type { ShotContent, StoryboardComparison } from "../../../shared/storyboard-candidate";
import { StoryboardPanelLifecycle } from "../../../shared/storyboard-panel-lifecycle";
import { command } from "../api/client";

const FIELDS: ReadonlyArray<[keyof ShotContent, string]> = [
  ["title", "名称"], ["description", "画面"], ["action", "动作"], ["shotSize", "景别"], ["cameraMovement", "运镜"], ["audio", "对白或声音"],
];

type Readiness = CommandOutputs["storyboard.readiness"]["state"];
const STATUS: Record<Readiness, string> = {
  disabled: "DeepSeek 分镜策划已关闭。仍可手动添加镜头。",
  missing_key: "DeepSeek 分镜策划未检测到本地密钥。仍可手动添加镜头。",
  configuration_present: "检测到本地 DeepSeek 配置。未验证密钥、联网或计费状态。",
};

export function StoryboardGeneration({ taskId, revision, ready, onAdopt }: {
  taskId: string; revision: number; ready: boolean;
  onAdopt(value: CommandOutputs["storyboard.adoptDraft"]): boolean;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [readinessError, setReadinessError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ taskId: string; revision: number; value: StoryboardComparison; token: string | null } | null>(null);
  const mounted = useRef(false);
  const scope = useRef<StoryboardPanelLifecycle | null>(null);
  if (!scope.current) scope.current = new StoryboardPanelLifecycle();
  const lifecycle = scope.current;
  const requesting = useRef(false);

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; lifecycle.close(); }; }, [lifecycle]);
  useLayoutEffect(() => { lifecycle.update(taskId, revision, ready); }, [lifecycle, taskId, revision, ready]);
  useEffect(() => {
    let active = true;
    void command("storyboard.readiness", {}).then(result => {
      if (active) setReadiness(result.state);
    }).catch(() => { if (active) setReadinessError(true); });
    return () => { active = false; };
  }, [taskId]);
  useEffect(() => { setPreview(null); setError(""); }, [taskId, revision, ready]);
  async function generate() {
    if (readiness !== "configuration_present" || !ready || requesting.current) return;
    const isCurrent = lifecycle.capture(taskId, revision);
    if (!isCurrent) return;
    requesting.current = true;
    setBusy(true); setError(""); setPreview(null);
    try {
      const result = await command("storyboard.generatePreview", { taskId, expectedRevision: revision });
      if (isCurrent() && result.status === "ready" && result.revision === revision) {
        setPreview({ taskId, revision: result.revision, value: result.preview, token: result.adoptionToken });
      }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "分镜候选生成失败，当前分镜未改变。");
    } finally {
      requesting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function adopt() {
    if (requesting.current || !ready || preview?.taskId !== taskId || preview.revision !== revision || !preview.token) return;
    const isCurrent = lifecycle.capture(taskId, revision);
    if (!isCurrent) return;
    requesting.current = true;
    setBusy(true); setError("");
    try {
      const result = await command("storyboard.adoptDraft", { taskId, expectedRevision: revision, token: preview.token });
      if (!isCurrent()) return;
      setPreview(null);
      if (result.taskId !== taskId || result.revision !== revision || !onAdopt(result)) {
        setError("当前草稿已变化，本次候选未写入，请检查并保存后重试。");
      }
    } catch (cause) {
      if (isCurrent()) { setPreview(null); setError(cause instanceof Error ? cause.message : "未采用候选，当前分镜未改变。"); }
    } finally {
      requesting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const shown = ready && preview?.taskId === taskId && preview.revision === revision ? preview.value : null;
  return <section className="prompt-history" aria-label="DeepSeek 分镜策划">
    <p className="helper" role="status">{readiness ? STATUS[readiness] : readinessError
      ? "无法读取本地策划配置。仍可手动添加镜头。" : "正在读取本地策划配置（不会联网）…"}</p>
    <button className="text-button" disabled={readiness !== "configuration_present" || !ready || busy} onClick={() => void generate()}>生成分镜候选 · DeepSeek</button>
    <p className="helper">只使用已保存剧本。需另行确认发送至 DeepSeek，可能计费；生成不会修改当前分镜。候选完整保留原镜头顺序和内容时，也可主动追加其后新增的镜头。也可继续手动添加镜头。</p>
    {busy && <p role="status">正在处理分镜候选…</p>}
    {error && <p role="alert">{error}</p>}
    {shown && <div>
      <button className="text-button" onClick={() => { lifecycle.cancel(); setPreview(null); }}>关闭候选</button>
      {preview?.token
        ? <><button className="text-button" disabled={busy} onClick={() => void adopt()}>{shown.rows.some(row => row.current) ? "追加新镜头为草稿" : "采用为分镜草稿"}</button>
          <p className="helper">仅加入末尾新增镜头，保留原镜头和关联。新增镜头可编辑，并沿用画布自动保存；请核对内容。</p></>
        : <p className="helper">候选与原镜头不同，或末尾无新增镜头，仅供对照；不会替换现有镜头。</p>}
      <p className="helper">差异仅按镜头位置比较，不表示镜头身份变化。候选额外位置 {shown.extraCandidatePositions}，当前额外位置 {shown.extraCurrentPositions}。</p>
      {shown.rows.map(row => <details key={row.order}>
        <summary>镜头 {String(row.order).padStart(2, "0")} · {row.candidate?.title ?? "无候选"} · {row.changedFields.length} 项不同</summary>
        {FIELDS.map(([field, label]) => <div key={field}><strong>{label}</strong>
          {row.current && <p style={{ whiteSpace: "pre-wrap" }}>当前：{row.current[field] || "（空）"}</p>}
          {row.candidate && <p style={{ whiteSpace: "pre-wrap" }}>候选：{row.candidate[field] || "（空）"}</p>}
        </div>)}
      </details>)}
    </div>}
  </section>;
}
