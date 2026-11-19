import { useRef, useState } from "react";
import type { TaskWorkspace } from "../../../shared/models";
import { previewAssetLinks, adoptAssetLinkSuggestions } from "../../../shared/asset-link-suggestions";

/** Local rule preview only. Choosing a checkbox never changes the workspace. */
export function AssetLinkSuggestions({ workspace, shotId, busy, onChange }: {
  workspace: TaskWorkspace; shotId: string; busy: boolean; onChange: (next: TaskWorkspace) => void;
}) {
  const [preview, setPreview] = useState<ReturnType<typeof previewAssetLinks> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const consumed = useRef(false);
  const suggestions = preview?.suggestions.filter(item => item.shotId === shotId) ?? [];
  function refresh() {
    consumed.current = false;
    setPreview(previewAssetLinks(workspace)); setSelected([]); setMessage("");
  }
  function adopt() {
    if (!preview || busy || consumed.current || !selected.length) return;
    consumed.current = true;
    try {
      const next = adoptAssetLinkSuggestions(workspace, preview, selected);
      onChange(next); setPreview(null); setSelected([]);
      setMessage("已增补勾选关联，原有关联和内容保留；请查看画布保存状态并核对受影响提示词。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "关联建议已失效，请重新预览。");
      setPreview(null); setSelected([]);
    }
  }
  return <div aria-label="本地关联建议">
    <button className="text-button" disabled={busy} onClick={refresh}>预览本地关联建议</button>
    <p className="helper">仅按已有资产名称匹配本镜头标题、画面与动作，不是 AI 提取。可能漏判或误判，不理解否定、别名或隐含指代；请逐项核对，不会自动连线或新增资产。</p>
    {preview && <div>
      {suggestions.length === 0 && <p role="status">没有可增补的明确名称匹配。已有连线不重复推荐；短名称或同名资产可能被跳过，仍可手动勾选。</p>}
      {suggestions.map(item => <label className="asset-checkbox" key={item.id}>
        <input type="checkbox" disabled={busy} checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
        <span>{workspace.assets.find(asset => asset.id === item.assetId)?.name ?? "资产已变化"}<small className="helper">匹配依据（{({ title: "标题", description: "画面", action: "动作" })[item.field]}）：{item.evidence}</small></span>
      </label>)}
      <button className="text-button" disabled={busy || !selected.length} onClick={adopt}>采用勾选关联（{selected.length}）</button>
      <button className="text-button" disabled={busy} onClick={() => { consumed.current = true; setPreview(null); setSelected([]); setMessage("已关闭建议，未修改关联。"); }}>关闭建议</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
