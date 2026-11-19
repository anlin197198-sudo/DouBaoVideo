import { viewportForTarget } from "../../../shared/canvas-focus";
import { command } from "../api/client";
import { acceptScriptReuseDraft, type ScriptReusePreview } from "../../../shared/script-reuse-draft";
import { applyTemporaryTemplate, type TemporaryTemplateApply } from "../../../shared/temporary-template-apply";
import { imagePreview, refreshImagePreviews, settleImagePreview, type ImagePreviewState } from "../../../shared/image-preview-state";
import type { PlanStyleContext } from "../../../shared/prompts";
import { useEffect, useRef, useState } from "react";
import { WorkspaceAutosave, type SaveState } from "../../../shared/workspace-autosave";
import { nextLocalStep, productionNodes, productionEdges, storeProductionPositions } from "../../../shared/canvas-production";
import { arrangeCanvas, canvasBoxes, placeAddedNodes, preserveProductionPositions } from "../../../shared/canvas-layout";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  type Node,
  type NodeChangeset,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import type { AssetType, ProductionAsset, ReferenceImage, StoryboardShot, TaskWorkspace, VideoTask } from "../../../shared/models";
import { addShot, editScript, MAX_SHOTS, moveShot, removeShot } from "../../../shared/storyboard";
import { addAsset, ASSET_LABELS, mergeAssets } from "../../../shared/assets";
import { AssetLinkSuggestions } from "../components/AssetLinkSuggestions";
import { AssetEditor, AssetLibrary } from "../components/AssetPanel";
import { connectionError, removeAsset, setAssetLink } from "../../../shared/asset-links";
import { appendStoryboardDraft } from "../../../shared/storyboard-draft";
import { StoryboardGeneration } from "../components/StoryboardGeneration";
import { ScriptHistory } from "../components/ScriptHistory";
import { PromptPanel } from "../components/PromptPanel";
import { FramePanel } from "../components/FramePanel";
import { SaveConflictDialog } from "../components/SaveConflictDialog";
import { invalidateChangedConfirmation } from "../../../shared/frames";
import type { Plan } from "../../../shared/models";

export function TaskCanvas({ task, planStyle, busy, referenceImages, onSave, onConfirm, onReadLatest, onBack }: {
  task: VideoTask;
  planStyle: PlanStyleContext;
  busy: boolean;
  referenceImages: ReferenceImage[];
  onSave: (workspace: TaskWorkspace, revision: number) => Promise<VideoTask>;
  onConfirm: () => Promise<VideoTask | null>;
  onReadLatest: () => Promise<VideoTask>;
  onBack: () => void;
}) {
  const [workspace, setWorkspace] = useState(task.workspace);
  const flow = useRef<ReactFlowInstance | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const focusOperation = useRef(0);
  useEffect(() => () => { focusOperation.current++; }, []);
  const measuredSizes = () => new Map((flow.current?.getNodes() ?? []).map(node => [node.id, node.measured ?? {}]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promptSelection, setPromptSelection] = useState("video");
  const [promptOpenRequest, setPromptOpenRequest] = useState(0);
  const [frameSlot, setFrameSlot] = useState<"first" | "last">("first");
  const [imagePreviews, setImagePreviews] = useState<ImagePreviewState>({});
  const refreshPreviews = (ids: string[]) => setImagePreviews(previous => refreshImagePreviews(previous, ids));
  const settlePreview = (id: string, epoch: number, status: "ready" | "failed") => setImagePreviews(previous => settleImagePreview(previous, id, epoch, status));
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ dirty: false, saving: false, error: null, requestId: null, conflict: false });
  const [conflictOpen, setConflictOpen] = useState(false);
  const [canvasReload, setCanvasReload] = useState(0);
  const dirty = saveState.dirty;
  const [leaving, setLeaving] = useState(false);
  const [closeNotice, setCloseNotice] = useState(false);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [framesOpen, setFramesOpen] = useState(false);
  const [images, setImages] = useState(referenceImages);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [imageRefresh, setImageRefresh] = useState(0);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<{ assetId: string; shotId: string } | null>(null);
  const working = busy || referenceBusy || leaving;
  const applyLive = useRef({ taskId: task.id, planStyle, working });
  applyLive.current = { taskId: task.id, planStyle, working };
  const saveCallback = useRef(onSave);
  saveCallback.current = onSave;
  const controllerRef = useRef<WorkspaceAutosave | null>(null);
  if (!controllerRef.current) controllerRef.current = new WorkspaceAutosave(task,
    (value, revision) => saveCallback.current(value, revision), (state, normalized) => {
      setSaveState(state);
      if (normalized) { setWorkspace(normalized); setLinkMessage(null); }
    });
  const controller = controllerRef.current;
  useEffect(() => { if (saveState.conflict) setConflictOpen(true); }, [saveState.conflict]);
  useEffect(() => { setImages(previous => [...new Map([...previous, ...referenceImages].map(image => [image.id, image])).values()]); }, [referenceImages]);
  useEffect(() => {
    controller.pause(busy || referenceBusy);
  }, [controller, busy, referenceBusy]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (controller.state.dirty || controller.state.saving || referenceBusy) {
        event.preventDefault(); event.returnValue = "尚有未保存内容"; setCloseNotice(true);
        void controller.flush();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [controller, referenceBusy]);
  useEffect(() => () => controller.dispose(), [controller]);
  const selectedIndex = workspace.shots.findIndex(shot => shot.id === selectedId);
  const selectedShot = workspace.shots[selectedIndex];
  const selectedAsset = workspace.assets.find(asset => asset.id === selectedId);
  const reviewCount = workspace.shots.filter(shot => shot.needsReview).length;
  const production = productionNodes(workspace, planStyle);
  const nextStep = nextLocalStep(workspace, planStyle);
  const nodes: Node[] = [{
    id: "script",
    position: workspace.scriptPosition,
    sourcePosition: Position.Right,
    selected: selectedId === "script",
    data: { label: <div className="script-node">
      <small>剧本</small>
      <strong>{task.title}</strong>
      <p>{workspace.script || "点击节点，开始编辑剧本。"}</p>
    </div> },
  }, ...workspace.shots.map((shot, index): Node => ({
    id: shot.id,
    position: shot.position,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: selectedId === shot.id,
    className: selectedAsset && workspace.assetLinks.some(link => link.assetId === selectedAsset.id && link.shotId === shot.id) ? "linked-node" : "",
    data: { label: <div className="script-node shot-node">
      <small>分镜 {String(index + 1).padStart(2, "0")}{shot.needsReview ? " · 待核对剧本" : ""}</small>
      {shot.assetsNeedReview && <small>资产关联或设定待核对</small>}
      <strong>{shot.title || "未命名镜头"}</strong>
      <p>{shot.description || "点击填写画面与动作。"}</p>
      {shot.shotSize && <span className="muted node-short-detail">{shot.shotSize}</span>}
    </div> },
  })), ...workspace.assets.map((asset): Node => ({
    id: asset.id, position: asset.position, selected: selectedId === asset.id,
    className: selectedShot && workspace.assetLinks.some(link => link.shotId === selectedShot.id && link.assetId === asset.id) ? "linked-node" : "",
    sourcePosition: Position.Right, targetPosition: Position.Left,
    data: { label: <div className="script-node asset-node">
      <small>{ASSET_LABELS[asset.type]} · v{asset.version}{asset.needsReview ? " · 待核对" : ""}</small>
      {asset.referenceImageId && <img key={`${asset.referenceImageId}-${imageRefresh}`} src={`app://media/${asset.referenceImageId}?v=${imageRefresh}`} alt={`${asset.name}参考图`}
        onError={event => { event.currentTarget.style.display = "none"; }} />}
      <strong>{asset.name || "未命名资产"}</strong><p>{asset.description || "点击填写设定和参考图。"}</p>
    </div> },
  })), ...production.prompts.map((prompt): Node => ({
    id: prompt.id, position: prompt.position, selected: selectedId === prompt.id, connectable: false,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    data: { label: <div className="script-node"><small>手动提示词 · {prompt.status}</small><strong>{prompt.title}</strong><p>{prompt.summary}</p></div> },
  })), ...production.frames.map((frame): Node => ({
    id: frame.id, position: frame.position, selected: selectedId === frame.id, connectable: false,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    data: { label: <div className="script-node"><small>静态图片 · {frame.candidate && (imagePreview(imagePreviews, frame.candidate.imageId).status === "failed") ? "文件不可读" : frame.status}</small><strong>{frame.title}</strong>
      {frame.candidate && !(imagePreview(imagePreviews, frame.candidate.imageId).status === "failed") && <img
        key={`${frame.candidate.imageId}-${imagePreview(imagePreviews, frame.candidate.imageId).epoch}`}
        src={`app://media/${frame.candidate.imageId}?v=${imagePreview(imagePreviews, frame.candidate.imageId).epoch}`} alt={`${frame.title}当前图片`}
        style={{ width: "100%", height: 150, objectFit: "contain" }}
        onLoad={() => settlePreview(frame.candidate!.imageId, imagePreview(imagePreviews, frame.candidate!.imageId).epoch, "ready")}
        onError={() => settlePreview(frame.candidate!.imageId, imagePreview(imagePreviews, frame.candidate!.imageId).epoch, "failed")} />}
      <p>{frame.candidate ? (imagePreview(imagePreviews, frame.candidate.imageId).status === "failed") ? "图片无法读取，点击重新导入或选择。" : "本地导入 · 点击预览与审核" : "点击导入并选择当前图片。"}</p>
    </div> },
  }))];
  const edges: Edge[] = [...workspace.shots.map(shot => ({
    id: `script-${shot.id}`,
    source: "script",
    target: shot.id,
    selectable: false,
    style: { stroke: "#b8c9be", strokeWidth: 1.3 },
  })), ...workspace.assetLinks.map(link => ({
    id: `asset-${link.assetId}-${link.shotId}`, source: link.assetId, target: link.shotId,
    data: { link }, reconnectable: false,
    selected: selectedLink?.assetId === link.assetId && selectedLink.shotId === link.shotId,
    style: { stroke: "#517861", strokeWidth: 2 },
    ariaLabel: `资产关联：${workspace.assets.find(asset => asset.id === link.assetId)?.name} → ${workspace.shots.find(shot => shot.id === link.shotId)?.title}`,
  })), ...productionEdges(workspace).map(edge => ({
    ...edge, id: `source:${edge.source}:${edge.target}`, selectable: false, reconnectable: false,
    style: { stroke: "#b8c9be", strokeWidth: 1.3, strokeDasharray: "4 4" },
    ariaLabel: "制作来源关系（只读）",
  }))];

  function link(assetId: string, shotId: string, linked: boolean) {
    if (working) return;
    try {
      edit(setAssetLink(workspace, assetId, shotId, linked));
      setLinkMessage(linked ? "已关联资产，保存画布后生效。" : "已解除引用，其他镜头不受影响。请保存画布。");
      setSelectedLink(null);
    } catch (error) { setLinkMessage(error instanceof Error ? error.message : "无法关联资产。"); }
  }

  function edit(next: TaskWorkspace) {
    if (next === controller.workspace) return;
    const positioned = preserveProductionPositions(controller.workspace, invalidateChangedConfirmation(controller.workspace, next, planStyle));
    setWorkspace(positioned);
    controller.update(positioned);
  }

  const applyTemplate: TemporaryTemplateApply = (envelope, context, editor) => {
    const live = applyLive.current;
    if (live.working || context.taskId !== live.taskId) return false;
    const state = controller.state;
    const result = applyTemporaryTemplate(envelope, { ...context, taskId: live.taskId, revision: controller.savedRevision,
      workspace: controller.workspace, plan: live.planStyle,
      saveState: { dirty: state.dirty, saving: state.saving, error: state.error, conflict: state.conflict } }, editor, true);
    if (result.status !== "draft-applied") return false;
    const positioned = preserveProductionPositions(controller.workspace, result.workspace);
    setWorkspace(positioned); controller.update(positioned); return true;
  };

  async function reuseScript(preview: ScriptReusePreview, current: () => boolean): Promise<boolean> {
    const live = applyLive.current;
    if (!current() || live.working || preview.taskId !== live.taskId || preview.revision !== controller.savedRevision
      || controller.state.dirty || controller.state.saving || controller.state.error || controller.state.conflict) return false;
    const result = await command("scripts.applyReuse", { taskId: preview.taskId, expectedRevision: preview.revision, token: preview.token });
    const latest = applyLive.current;
    if (!current() || latest.working) return false;
    const workspace = acceptScriptReuseDraft(result, { taskId: latest.taskId, revision: controller.savedRevision, workspace: controller.workspace, plan: latest.planStyle, state: controller.state });
    if (!workspace) return false;
    if (result.changed) { setWorkspace(workspace); controller.update(workspace); }
    return true;
  }

  function updateShot(patch: Partial<StoryboardShot>) {
    edit({ ...workspace, shots: workspace.shots.map(shot =>
      shot.id === selectedId ? { ...shot, ...patch } : shot) });
  }

  function select(id: string | null) {
    focusOperation.current++;
    if (working) return;
    setSelectedId(id);
    setAssetLibraryOpen(false);
    setPromptsOpen(!!id?.startsWith("prompt:"));
    setFramesOpen(!!id?.startsWith("frame:"));
    if (id?.startsWith("prompt:")) { setPromptSelection(id.slice(7)); setPromptOpenRequest(value => value + 1); }
    if (id === "frame:first" || id === "frame:last") setFrameSlot(id === "frame:first" ? "first" : "last");
    setDeletingId(null);
    setSelectedLink(null);
  }

  function changeNodes(changes: NodeChangeset<Node>) {
    const positions = new Map(changes.applyTo(nodes).map(node => [node.id, node.position]));
    const moved = nodes.some(node => {
      const position = positions.get(node.id);
      return position && (position.x !== node.position.x || position.y !== node.position.y);
    });
    if (moved) edit({
      ...workspace,
      scriptPosition: positions.get("script") ?? workspace.scriptPosition,
      shots: workspace.shots.map(shot => ({ ...shot, position: positions.get(shot.id) ?? shot.position })),
      assets: workspace.assets.map(asset => ({ ...asset, position: positions.get(asset.id) ?? asset.position })),
      productionPositions: storeProductionPositions(workspace, positions),
    });
  }

  function createAsset(type: AssetType) {
    const id = crypto.randomUUID();
    const next = placeAddedNodes(workspace, addAsset(workspace, id, type), measuredSizes());
    if (next !== workspace) { edit(next); select(id); }
  }

  function updateAsset(id: string, patch: Partial<ProductionAsset>) {
    const previous = controller.workspace;
      const old = previous.assets.find(asset => asset.id === id);
      const contentChanged = old && (["name", "type", "description", "referenceImageId"] as const)
        .some(key => key in patch && patch[key] !== old[key]);
      edit({ ...previous, assets: previous.assets.map(asset => asset.id === id ? { ...asset, ...patch } : asset),
        shots: previous.shots.map(shot => contentChanged && previous.assetLinks.some(link => link.assetId === id && link.shotId === shot.id)
          ? { ...shot, assetsNeedReview: true } : shot) });
  }

  function add() {
    const id = crypto.randomUUID();
    const next = placeAddedNodes(workspace, addShot(workspace, id), measuredSizes());
    if (next !== workspace) { edit(next); select(id); }
  }

  async function save(): Promise<boolean> {
    if (controller.state.conflict) { setConflictOpen(true); return false; }
    return controller.flush(true);
  }

  function advance() {
    if (working) return;
    if (nextStep.target === "add-shot") add();
    else if (nextStep.target === "assets") { select(null); setAssetLibraryOpen(true); }
    else {
      select(nextStep.target);
      // The review overlay conceals the canvas; opening its exact role is sufficient.
      if (nextStep.target.startsWith("frame:")) return;
      const operation = focusOperation.current, capturedFlow = flow.current, capturedTask = task.id;
      requestAnimationFrame(() => {
        if (operation !== focusOperation.current || applyLive.current.working || applyLive.current.taskId !== capturedTask || flow.current !== capturedFlow) return;
        const instance = flow.current, host = stage.current;
        const node = instance?.getNode(nextStep.target);
        if (!instance || !host || !node) return;
        const box = canvasBoxes(controller.workspace, measuredSizes()).find(item => item.id === node.id);
        if (!box) return;
        const bounds = host.getBoundingClientRect();
        const editor = host.querySelector<HTMLElement>(".node-editor")?.getBoundingClientRect();
        const visibleWidth = editor ? Math.max(0, Math.min(host.clientWidth, editor.left - bounds.left - 12)) : host.clientWidth;
        const viewport = viewportForTarget(instance.getViewport(), { width: visibleWidth, height: host.clientHeight },
          { position: node.position, width: node.measured?.width ?? box.width, height: node.measured?.height ?? box.height });
        if (viewport) void instance.setViewport(viewport, { duration: 0 }).catch(() => undefined);
      });
    }
  }

  return <div className="canvas-page">
    {conflictOpen && <SaveConflictDialog local={workspace} localRevision={controller.savedRevision} onReadLatest={onReadLatest}
      onClose={() => setConflictOpen(false)} onResolve={async (latest, choice) => {
        const resolved = await controller.resolveConflict(latest, choice);
        if (resolved && choice === "discard") {
          focusOperation.current++; setCanvasReload(value => value + 1); setSelectedId(null); setPromptsOpen(false); setFramesOpen(false); setAssetLibraryOpen(false);
        }
        return resolved;
      }} />}
    <div className="canvas-heading">
      <button className="text-button" disabled={working} onClick={() => {
        setLeaving(true);
        void save().then(saved => { if (saved) onBack(); else setLeaving(false); });
      }}>← 返回周计划</button>
      <span className="muted" role="status">{saveState.error ? `保存失败：${saveState.error} 草稿仍保留，请重试。` : saveState.saving ? "保存中…" : dirty ? "等待自动保存…" : "已保存"}</span>
      {saveState.error && saveState.requestId && <small>保存请求编号 {saveState.requestId}</small>}
    </div>
    <div className="page-heading">
      <h1>{task.title}</h1>
      <button className="primary" disabled={working} onClick={advance}>{nextStep.label}</button>
      <button className="text-button" disabled={working || saveState.saving || !dirty} onClick={() => { void save(); }}>
        {saveState.saving ? "保存中…" : saveState.conflict ? "解决保存冲突" : saveState.error ? "重试保存" : "保存画布"}
      </button>
    </div>
    <div className="canvas-toolbar">
      <div className="canvas-tools">
        <button className="text-button" onClick={() => select("script")}>编辑剧本</button>
        <button className="text-button" disabled={working || !workspace.script.trim() || workspace.shots.length >= MAX_SHOTS}
          onClick={add}>＋ 添加镜头</button>
        <button className="text-button" disabled={working} onClick={() => edit(arrangeCanvas(workspace, measuredSizes()))}>整理布局</button>
        <button className="text-button" disabled={working} onClick={() => {
          select(null); setAssetLibraryOpen(true);
        }}>资产（{workspace.assets.length}）</button>
        <button className="text-button" disabled={working} onClick={() => select(promptsOpen ? null : "prompt:video")}>提示词与风格</button>
        <button className="text-button" disabled={working} onClick={() => select(framesOpen ? null : "frame:first")}>首尾帧与审核</button>
      </div>
      <span className="muted">{workspace.shots.length} 个镜头{reviewCount > 0 ? ` · ${reviewCount} 个待核对` : ""}</span>
    </div>
    <p className="helper">本地手动制作；真实生成尚未接入。虚线表示只读来源关系，实线资产引用可调整。</p>
    {promptsOpen && <PromptPanel key={promptOpenRequest} taskId={task.id} savedRevision={controller.savedRevision} saveState={saveState} onApplyTemplate={applyTemplate} workspace={workspace} planStyle={planStyle} disabled={working} restoreDisabled={working || saveState.dirty || saveState.saving || saveState.conflict || !!saveState.error} onChange={edit} initialSelection={promptSelection} onClose={() => select(null)} />}
    {closeNotice && <p role="status" className="review-notice">已阻止关闭以保护尚未保存的内容。等待显示“已保存”后可再次关闭；保存失败时请先重试。</p>}
    {framesOpen && <FramePanel workspace={workspace} planStyle={planStyle} taskId={task.id} images={images} busy={working || saveState.saving} dirty={dirty} saveState={saveState} savedRevision={controller.savedRevision}
      onChange={edit} onBusy={setReferenceBusy} onEditPrompt={kind => select(`prompt:${kind}`)} focusSlot={frameSlot} onClose={() => select(null)}
      imagePreviews={imagePreviews} onPreviewEvent={settlePreview} onRefreshImages={refreshPreviews}
      onImport={image => { setImages(previous => [...previous.filter(item => item.id !== image.id), image]); refreshPreviews([image.id]); setImageRefresh(previous => previous + 1); }}
      onConfirm={async () => { if (controller.state.dirty || controller.state.saving || working) return;
        const confirmed = await onConfirm(); if (confirmed) controller.accept(confirmed); }} />}
    {linkMessage && <p className="link-notice" role="status">{linkMessage}</p>}
    {selectedLink && <div className="link-notice">
      <span>选中资产关联</span>
      <button className="text-button" disabled={working} onClick={() => link(selectedLink.assetId, selectedLink.shotId, false)}>解除这条引用</button>
      <button className="text-button" onClick={() => setSelectedLink(null)}>取消</button>
    </div>}
    <div ref={stage} className="canvas-stage" inert={working}>
      <ReactFlow key={canvasReload} nodes={nodes} edges={edges} onNodesChange={changeNodes} nodeDragThreshold={0} onInit={instance => { focusOperation.current++; flow.current = instance; }}
        onNodeClick={(_event, node) => select(node.id)} onPaneClick={() => select(null)}
        onConnect={connection => link(connection.source, connection.target, true)}
        isValidConnection={connection => !working && !connectionError(workspace, connection.source, connection.target)}
        onConnectEnd={(_event, connection) => {
          if (!connection.isValid && connection.toNode)
            setLinkMessage("连接无效：请从人物、场景或道具的右侧端点，连到镜头左侧端点；不能连接自身。");
        }}
        onEdgeClick={(_event, edge) => {
          const relation = edge.data?.link as { assetId: string; shotId: string } | undefined;
          if (relation) setSelectedLink(relation);
        }}
        defaultViewport={workspace.viewport}
        onMoveStart={() => { focusOperation.current++; }}
        onMoveEnd={(_event, viewport) => {
          const latest = controller.workspace;
          if (viewport.x !== latest.viewport.x || viewport.y !== latest.viewport.y || viewport.zoom !== latest.viewport.zoom)
            edit({ ...latest, viewport });
        }}
        minZoom={0.1} maxZoom={4} nodesConnectable={!working} deleteKeyCode={null}>
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {assetLibraryOpen && <AssetLibrary assets={workspace.assets} busy={working} onCreate={createAsset}
        onSelect={select} onClose={() => setAssetLibraryOpen(false)} />}
      {selectedAsset && <AssetEditor key={selectedAsset.id} asset={selectedAsset} assets={workspace.assets}
        linkedShots={workspace.shots.filter(shot => workspace.assetLinks.some(link => link.assetId === selectedAsset.id && link.shotId === shot.id))}
        onSelectShot={select}
        images={images} taskId={task.id} busy={working} refresh={imageRefresh} onBusy={setReferenceBusy}
        onImport={image => {
          setImages(previous => [...previous.filter(item => item.id !== image.id), image]);
          refreshPreviews([image.id]);
          setImageRefresh(previous => previous + 1);
        }} onChange={patch => updateAsset(selectedAsset.id, patch)}
        onBack={() => { select(null); setAssetLibraryOpen(true); }}
        onDelete={() => {
          edit(removeAsset(workspace, selectedAsset.id));
          select(null); setAssetLibraryOpen(true);
        }} onMerge={(targetId, choices) => {
          edit(mergeAssets(workspace, selectedAsset.id, targetId, choices)); select(targetId);
        }} />}
      {(selectedId === "script" || selectedShot) && !selectedAsset && <aside className="node-editor" aria-label="节点详情">
        <div className="editor-heading">
          <h2>{selectedShot ? `分镜 ${String(selectedIndex + 1).padStart(2, "0")}` : "剧本正文"}</h2>
          <button className="text-button" aria-label="关闭节点详情" onClick={() => select(null)}>关闭</button>
        </div>
        {selectedShot ? <>
          <div className="shot-order" aria-label="镜头顺序">
            <span className="muted">播放顺序 {selectedIndex + 1} / {workspace.shots.length}</span>
            <button className="text-button" disabled={busy || selectedIndex === 0}
              onClick={() => edit(moveShot(workspace, selectedShot.id, -1))}>上移</button>
            <button className="text-button" disabled={busy || selectedIndex === workspace.shots.length - 1}
              onClick={() => edit(moveShot(workspace, selectedShot.id, 1))}>下移</button>
          </div>
          {selectedShot.needsReview && <div className="review-notice" role="status">
            <p>剧本已修改，请核对这个镜头。</p>
            <button className="text-button" onClick={() => updateShot({ needsReview: false })}>已核对剧本</button>
          </div>}
          <label>镜头名称<input aria-label="镜头名称" maxLength={120} value={selectedShot.title}
            onChange={event => updateShot({ title: event.target.value })} /></label>
          <label>画面内容<textarea aria-label="画面内容" className="shot-text" rows={3} maxLength={10000}
            value={selectedShot.description} onChange={event => updateShot({ description: event.target.value })}
            placeholder="这一镜头里，能看到什么？" /></label>
          <label>人物动作<textarea aria-label="人物动作" className="shot-text" rows={2} maxLength={10000}
            value={selectedShot.action} onChange={event => updateShot({ action: event.target.value })} /></label>
          <details><summary>景别、运镜与声音</summary>
            <label>景别<input aria-label="景别" maxLength={120} value={selectedShot.shotSize}
              placeholder="例如：中景、特写" onChange={event => updateShot({ shotSize: event.target.value })} /></label>
            <label>运镜<input aria-label="运镜" maxLength={500} value={selectedShot.cameraMovement}
              placeholder="例如：固定、缓慢推进" onChange={event => updateShot({ cameraMovement: event.target.value })} /></label>
            <label>对白或旁白<textarea aria-label="对白或旁白" className="shot-text" rows={2} maxLength={10000}
              value={selectedShot.audio} onChange={event => updateShot({ audio: event.target.value })} /></label>
          </details>
          <p className="helper">上移、下移改变镜头顺序。拖动节点只调整画布位置。</p>
          <fieldset className="shot-assets"><legend>关联资产</legend>
            <AssetLinkSuggestions key={selectedShot.id} workspace={workspace} shotId={selectedShot.id} busy={working || saveState.conflict} onChange={edit} />
            {selectedShot.assetsNeedReview && <div className="review-notice"><p>资产关联或设定已变化，请核对这个镜头，并在提示词面板核对受影响的提示词。</p>
              <button className="text-button" disabled={working || dirty} onClick={() => updateShot({ assetsNeedReview: false })}>已核对资产</button>
              {dirty && <p className="helper">先保存当前修改，再确认核对结果。</p>}
            </div>}
            <p className="helper">勾选与画布拖线保持一致。取消勾选仅解除当前镜头引用。</p>
            {workspace.assets.length === 0 && <p className="helper">请先在“资产”中添加人物、场景或道具。</p>}
            {workspace.assets.map(asset => <label className="asset-checkbox" key={asset.id}>
              <input type="checkbox" disabled={working} checked={workspace.assetLinks.some(link => link.shotId === selectedShot.id && link.assetId === asset.id)}
                onChange={event => link(asset.id, selectedShot.id, event.target.checked)} />
              <span>{asset.name}（{ASSET_LABELS[asset.type]}）</span>
            </label>)}
          </fieldset>
          {deletingId === selectedShot.id ? <div className="shot-delete-confirm" role="alert">
            <p>删除“{selectedShot.title || "未命名镜头"}”？保存画布后会写入本地。</p>
            <div className="canvas-tools">
              <button className="text-button danger" disabled={busy} onClick={() => {
                edit(removeShot(workspace, selectedShot.id)); select("script");
              }}>确认删除</button>
              <button className="text-button" onClick={() => setDeletingId(null)}>取消</button>
            </div>
          </div> : <button className="text-button danger" disabled={busy}
            onClick={() => setDeletingId(selectedShot.id)}>删除镜头</button>}
        </> : <>
          <label>编辑内容<textarea aria-label="剧本正文" rows={10} maxLength={100000}
            value={workspace.script} onChange={event => edit(editScript(workspace, event.target.value))}
            placeholder="写下故事、对白和画面。" /></label>
          <p className="helper">{workspace.script.trim() ? "剧本写好后，点击「添加镜头」逐个整理分镜。" : "先写下剧本，再添加分镜。"}</p>
          <p className="helper">编辑内容与位置会自动保存；返回前会保存最新修改。保存失败时草稿保留，请点击重试。</p>
          <StoryboardGeneration key={`storyboard-${task.id}`} taskId={task.id} revision={controller.savedRevision}
            ready={!!workspace.script.trim() && !working && !dirty && !saveState.saving && !saveState.conflict && !saveState.error}
            onAdopt={result => {
              const draft = appendStoryboardDraft({ taskId: task.id, revision: controller.savedRevision,
                workspace: controller.workspace, state: controller.state }, result);
              if (!draft) return false;
              edit(placeAddedNodes(controller.workspace, draft, measuredSizes()));
              return true;
            }} />
          <ScriptHistory key={task.id} taskId={task.id} savedRevision={controller.savedRevision} reuseDisabled={working || dirty || saveState.saving || !!saveState.error || saveState.conflict} onReuse={reuseScript} />
        </>}
      </aside>}
    </div>
  </div>;
}
