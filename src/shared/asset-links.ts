import type { TaskWorkspace } from "./models";

export function connectionError(workspace: TaskWorkspace, source: string | null, target: string | null): string | null {
  if (!source || !target) return "请从资产端点连接到镜头端点。";
  if (source === target) return "不能连接节点自身。";
  if (!workspace.assets.some(asset => asset.id === source)) return "起点必须是当前任务的人物、场景或道具。";
  if (!workspace.shots.some(shot => shot.id === target)) return "终点必须是当前任务的镜头。";
  return null;
}

/** All UI entry points share this immutable, duplicate-safe mutation. */
export function setAssetLink(workspace: TaskWorkspace, assetId: string, shotId: string, linked: boolean): TaskWorkspace {
  const error = connectionError(workspace, assetId, shotId);
  if (error) throw new Error(error);
  const exists = workspace.assetLinks.some(link => link.assetId === assetId && link.shotId === shotId);
  if (exists === linked) return workspace;
  return { ...workspace, shots: workspace.shots.map(shot => shot.id === shotId ? { ...shot, assetsNeedReview: true } : shot), assetLinks: linked
    ? [...workspace.assetLinks, { assetId, shotId }]
    : workspace.assetLinks.filter(link => link.assetId !== assetId || link.shotId !== shotId) };
}

export function removeAsset(workspace: TaskWorkspace, assetId: string): TaskWorkspace {
  const affected = new Set(workspace.assetLinks.filter(link => link.assetId === assetId).map(link => link.shotId));
  return { ...workspace, shots: workspace.shots.map(shot => affected.has(shot.id) ? { ...shot, assetsNeedReview: true } : shot), assets: workspace.assets.filter(asset => asset.id !== assetId),
    assetLinks: workspace.assetLinks.filter(link => link.assetId !== assetId) };
}

export function redirectAssetLinks(workspace: TaskWorkspace, sourceId: string, targetId: string): TaskWorkspace["assetLinks"] {
  const links = workspace.assetLinks.map(link => link.assetId === sourceId ? { ...link, assetId: targetId } : link);
  return uniqueAssetLinks(links);
}

export function uniqueAssetLinks(links: TaskWorkspace["assetLinks"]): TaskWorkspace["assetLinks"] {
  const seen = new Set<string>();
  return links.filter(link => {
    const key = `${link.assetId}:${link.shotId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
