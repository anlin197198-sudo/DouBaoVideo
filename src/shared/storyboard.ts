import type { TaskWorkspace } from "./models";

export const MAX_SHOTS = 200;

export function addShot(workspace: TaskWorkspace, id: string): TaskWorkspace {
  if (!workspace.script.trim() || workspace.shots.length >= MAX_SHOTS) return workspace;
  return {
    ...workspace,
    shots: [...workspace.shots, {
      id,
      title: "未命名镜头",
      description: "",
      action: "",
      shotSize: "",
      cameraMovement: "",
      audio: "",
      position: { x: 440, y: 80 + workspace.shots.length * 230 },
      needsReview: false,
    }],
  };
}

export function editScript(workspace: TaskWorkspace, script: string): TaskWorkspace {
  if (script === workspace.script) return workspace;
  return {
    ...workspace,
    script,
    shots: workspace.shots.map(shot => ({ ...shot, needsReview: true })),
    assets: workspace.assets.map(asset => ({ ...asset, needsReview: true })),
  };
}

export function moveShot(workspace: TaskWorkspace, id: string, offset: -1 | 1): TaskWorkspace {
  const index = workspace.shots.findIndex(shot => shot.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= workspace.shots.length) return workspace;
  const shots = [...workspace.shots];
  [shots[index], shots[target]] = [shots[target]!, shots[index]!];
  return { ...workspace, shots };
}

export function removeShot(workspace: TaskWorkspace, id: string): TaskWorkspace {
  return { ...workspace, shots: workspace.shots.filter(shot => shot.id !== id),
    ...(workspace.productionPositions ? { productionPositions: Object.fromEntries(Object.entries(workspace.productionPositions)
      .filter(([key]) => key !== `prompt:shot:${id}`)) } : {}),
    ...(workspace.prompts ? { prompts: workspace.prompts.filter(prompt => prompt.shotId !== id) } : {}),
    assetLinks: workspace.assetLinks.filter(link => link.shotId !== id) };
}
