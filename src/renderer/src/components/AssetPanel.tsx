import { useEffect, useState } from "react";
import type { AssetType, ProductionAsset, ReferenceImage, StoryboardShot } from "../../../shared/models";
import { ASSET_LABELS, MAX_ASSETS, type MergeChoices } from "../../../shared/assets";
import { command } from "../api/client";

export function ReferencePreview({ image, refresh = 0 }: { image: ReferenceImage; refresh?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image.id, refresh]);
  return <div className="reference-preview">
    <img key={`${image.id}-${refresh}`} src={`app://media/${image.id}?v=${refresh}`} alt={`参考图：${image.originalName}`}
      hidden={failed} onError={() => setFailed(true)} />
    {failed ? <p role="status">参考图暂不可用，请重新导入或移除。</p>
      : <small>{image.width} × {image.height} · {image.originalName}</small>}
  </div>;
}

export function AssetLibrary({ assets, busy, onCreate, onSelect, onClose }: {
  assets: ProductionAsset[]; busy: boolean;
  onCreate: (type: AssetType) => void; onSelect: (id: string) => void; onClose: () => void;
}) {
  const [filter, setFilter] = useState<AssetType | "all">("all");
  const visible = assets.filter(asset => filter === "all" || asset.type === filter);
  return <aside className="node-editor" aria-label="资产管理">
    <div className="editor-heading"><h2>资产管理</h2>
      <button className="text-button" aria-label="关闭资产管理" disabled={busy} onClick={onClose}>关闭</button></div>
    <p className="helper">先整理人物、场景与道具，再为镜头关联资产。</p>
    <div className="asset-create-actions">{(Object.keys(ASSET_LABELS) as AssetType[]).map(type =>
      <button key={type} className="asset-add" disabled={busy || assets.length >= MAX_ASSETS}
        onClick={() => onCreate(type)}>＋ {ASSET_LABELS[type]}</button>)}</div>
    <label>显示分类<select aria-label="资产分类筛选" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
      <option value="all">全部（{assets.length}）</option>
      {(Object.keys(ASSET_LABELS) as AssetType[]).map(type => <option key={type} value={type}>
        {ASSET_LABELS[type]}（{assets.filter(asset => asset.type === type).length}）</option>)}
    </select></label>
    <div className="asset-list">{visible.map(asset => <button className="asset-list-item" key={asset.id}
      disabled={busy} onClick={() => onSelect(asset.id)}>
      <span>{asset.name || "未命名资产"}</span><small>{ASSET_LABELS[asset.type]} · v{asset.version}</small>
    </button>)}</div>
    {visible.length === 0 && <p className="helper">这里还没有资产，点击上方分类添加。</p>}
    <p className="helper">资产设定和画布位置在点击“保存画布”或返回时保存。</p>
  </aside>;
}

export function AssetEditor({ asset, assets, images, taskId, busy, refresh, linkedShots, onSelectShot, onBusy, onImport, onChange, onDelete, onMerge, onBack }: {
  asset: ProductionAsset; assets: ProductionAsset[]; images: ReferenceImage[];
  taskId: string; busy: boolean; refresh: number;
  linkedShots: StoryboardShot[]; onSelectShot: (id: string) => void;
  onBusy: (busy: boolean) => void; onImport: (image: ReferenceImage) => void;
  onChange: (patch: Partial<ProductionAsset>) => void; onDelete: () => void;
  onMerge: (targetId: string, choices: MergeChoices) => void; onBack: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [choices, setChoices] = useState<MergeChoices>({ name: "target", description: "target", referenceImageId: "target" });
  const candidates = assets.filter(item => item.id !== asset.id && item.type === asset.type);
  const target = candidates.find(item => item.id === targetId);
  const reference = images.find(image => image.id === asset.referenceImageId);
  const selected = target ? { source: asset, target } : null;
  const mergedReference = selected ? images.find(image => image.id === selected[choices.referenceImageId].referenceImageId) : null;

  async function importImage() {
    onBusy(true); setError(null);
    try {
      const image = await command("assets.importReference", { taskId });
      if (image) { onImport(image); onChange({ referenceImageId: image.id }); }
    } catch (error) { setError(error instanceof Error ? error.message : "参考图导入失败，请重试。"); }
    finally { onBusy(false); }
  }

  return <aside className="node-editor" aria-label="资产详情">
    <div className="editor-heading"><h2>{ASSET_LABELS[asset.type]}设定</h2>
      <button className="text-button" disabled={busy} onClick={onBack}>资产列表</button></div>
    {asset.needsReview && <div className="review-notice"><p>剧本已修改，请核对资产设定。</p>
      <button className="text-button" onClick={() => onChange({ needsReview: false })}>已核对设定</button></div>}
    <label>资产名称<input aria-label="资产名称" maxLength={120} value={asset.name}
      onChange={event => onChange({ name: event.target.value })} /></label>
    <label>资产类型<select aria-label="资产类型" value={asset.type} onChange={event => {
      onChange({ type: event.target.value as AssetType }); setTargetId("");
    }}>{(Object.keys(ASSET_LABELS) as AssetType[]).map(type => <option key={type} value={type}>{ASSET_LABELS[type]}</option>)}</select></label>
    <label>设定描述<textarea aria-label="资产设定" className="shot-text" rows={4} maxLength={10000} value={asset.description}
      placeholder="例如：外貌、服装、场景氛围或道具特征。" onChange={event => onChange({ description: event.target.value })} /></label>
    <div className="editor-heading"><h2>参考图</h2>
      <button className="text-button" disabled={busy} onClick={() => { void importImage(); }}>{busy ? "处理中…" : "导入参考图"}</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {reference ? <>
      <ReferencePreview image={reference} refresh={refresh} />
      <button className="text-button" disabled={busy} onClick={() => onChange({ referenceImageId: null })}>移除当前参考图</button>
    </> : <p className="helper">支持 PNG、JPG、WebP，最大 20 MB。导入后保存在软件本地目录。</p>}
    {images.length > 0 && <label>复用本任务参考图<select aria-label="复用参考图" disabled={busy}
      value={asset.referenceImageId ?? ""} onChange={event => onChange({ referenceImageId: event.target.value || null })}>
      <option value="">不使用参考图</option>
      {images.map(image => <option key={image.id} value={image.id}>{image.originalName} · {image.width} × {image.height}</option>)}
    </select></label>}
    <p className="helper">当前 v{asset.version}。修改名称、类型、设定或参考图后，保存时增加版本；移动节点不增加内容版本。</p>
    <section aria-label="引用此资产的镜头"><h2>引用镜头（{linkedShots.length}）</h2>
      {linkedShots.length === 0 ? <p className="helper">还没有镜头引用此资产。</p> : linkedShots.map(shot =>
        <button key={shot.id} className="text-button" disabled={busy} onClick={() => onSelectShot(shot.id)}>{shot.title}</button>)}
    </section>
    <details><summary>合并重复资产</summary>
      <p className="helper">选择同类型的保留项，预览要保留的内容。合并后移除当前项，已有镜头引用转移到保留项并去重。</p>
      <label>保留资产<select aria-label="合并到资产" disabled={busy} value={target?.id ?? ""}
        onChange={event => setTargetId(event.target.value)}><option value="">选择保留项</option>
        {candidates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {target && selected && <>
        {([['name', '名称来源'], ['description', '设定来源'], ['referenceImageId', '参考图来源']] as const).map(([field, label]) =>
          <label key={field}>{label}<select aria-label={label} disabled={busy} value={choices[field]}
            onChange={event => setChoices({ ...choices, [field]: event.target.value as "source" | "target" })}>
            <option value="target">保留项：{target.name}</option><option value="source">当前项：{asset.name}</option>
          </select></label>)}
        <div className="merge-preview"><small>合并结果预览</small><strong>{selected[choices.name].name}</strong>
          <p>{selected[choices.description].description || "暂无设定"}</p>
          {mergedReference ? <ReferencePreview image={mergedReference} refresh={refresh} /> : <small>无参考图</small>}
        </div>
        <button className="text-button" disabled={busy || !selected[choices.name].name.trim()}
          onClick={() => onMerge(target.id, choices)}>确认合并</button>
      </>}
      {candidates.length === 0 && <p className="helper">当前没有其他同类型资产。</p>}
    </details>
    {deleting ? <div className="shot-delete-confirm" role="alert"><p>删除“{asset.name}”？将解除 {linkedShots.length} 个镜头的引用，镜头本身保留。已归档参考图会保留供复用。</p>
      <div className="canvas-tools"><button className="text-button danger" disabled={busy} onClick={onDelete}>确认删除资产</button>
        <button className="text-button" onClick={() => setDeleting(false)}>取消</button></div>
    </div> : <button className="text-button danger" disabled={busy} onClick={() => setDeleting(true)}>删除资产</button>}
  </aside>;
}
