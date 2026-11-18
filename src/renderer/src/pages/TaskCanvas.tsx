import { useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Node,
  type NodeChangeset,
} from "@xyflow/react";
import type { TaskWorkspace, VideoTask } from "../../../shared/models";

export function TaskCanvas({
  task,
  busy,
  onSave,
  onBack,
}: {
  task: VideoTask;
  busy: boolean;
  onSave: (workspace: TaskWorkspace) => Promise<boolean>;
  onBack: () => void;
}) {
  const [workspace, setWorkspace] = useState(task.workspace);
  const [selected, setSelected] = useState(true);
  const [dirty, setDirty] = useState(false);
  const editRevision = useRef(0);
  const nodes: Node[] = [
    {
      id: "script",
      position: workspace.scriptPosition,
      data: {
        label: (
          <div className="script-node">
            <small>剧本</small>
            <strong>{task.title}</strong>
            <p>{workspace.script || "点击节点，开始编辑剧本。"}</p>
          </div>
        ),
      },
    },
  ];

  function edit(patch: Partial<TaskWorkspace>) {
    editRevision.current += 1;
    setWorkspace((previous) => ({ ...previous, ...patch }));
    setDirty(true);
  }

  function changeNodes(changes: NodeChangeset<Node>) {
    const updated = changes.applyTo(nodes)[0];
    if (
      updated &&
      (updated.position.x !== workspace.scriptPosition.x ||
        updated.position.y !== workspace.scriptPosition.y)
    ) {
      edit({ scriptPosition: updated.position });
    }
  }

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    const savingRevision = editRevision.current;
    const saved = await onSave(workspace);
    const currentSaved = saved && savingRevision === editRevision.current;
    if (currentSaved) setDirty(false);
    return currentSaved;
  }

  return (
    <div className="canvas-page">
      <div className="canvas-heading">
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            void save().then((saved) => {
              if (saved) onBack();
            });
          }}
        >
          ← 返回周计划
        </button>
        <span className="muted" role="status">
          {dirty ? "有待保存的修改" : "已保存"}
        </span>
      </div>
      <div className="page-heading">
        <h1>{task.title}</h1>
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => {
            void save();
          }}
        >
          {busy ? "正在保存…" : "保存剧本"}
        </button>
      </div>
      <div className="canvas-stage">
        <ReactFlow
          nodes={nodes}
          edges={[]}
          onNodesChange={changeNodes}
          onNodeClick={() => setSelected(true)}
          onPaneClick={() => setSelected(false)}
          defaultViewport={workspace.viewport}
          onMoveEnd={(_event, viewport) => {
            edit({ viewport });
          }}
          minZoom={0.1}
          maxZoom={4}
          nodesConnectable={false}
          deleteKeyCode={null}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {selected && (
          <aside className="node-editor">
            <div className="editor-heading">
              <h2>剧本正文</h2>
              <button
                className="text-button"
                aria-label="关闭节点详情"
                onClick={() => setSelected(false)}
              >
                关闭
              </button>
            </div>
            <label>
              编辑内容
              <textarea
                aria-label="剧本正文"
                rows={13}
                maxLength={100000}
                value={workspace.script}
                onChange={(event) => {
                  edit({ script: event.target.value });
                }}
                placeholder="写下故事、对白和画面。"
              />
            </label>
            <p className="helper">保存后，剧本与画布位置会写入本地工作区。</p>
          </aside>
        )}
      </div>
    </div>
  );
}
