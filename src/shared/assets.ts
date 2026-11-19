import type { AssetType, ProductionAsset, TaskWorkspace } from "./models";
import { redirectAssetLinks } from "./asset-links";

export const ASSET_LABELS: Record<AssetType, string> = { person: "人物", scene: "场景", prop: "道具" };
export const MAX_ASSETS = 200;

export function addAsset(workspace: TaskWorkspace, id: string, type: AssetType): TaskWorkspace {
  if (workspace.assets.length >= MAX_ASSETS) return workspace;
  return { ...workspace, assets: [...workspace.assets, {
    id, type, name: `未命名${ASSET_LABELS[type]}`, description: "", referenceImageId: null,
    version: 1, position: { x: 820, y: 80 + workspace.assets.length * 250 }, needsReview: false,
  }] };
}

export type MergeChoices = Record<"name" | "description" | "referenceImageId", "source" | "target">;

export function mergeAssets(
  workspace: TaskWorkspace, sourceId: string, targetId: string, choices: MergeChoices,
): TaskWorkspace {
  const source = workspace.assets.find(asset => asset.id === sourceId);
  const target = workspace.assets.find(asset => asset.id === targetId);
  if (!source || !target || sourceId === targetId || source.type !== target.type) return workspace;
  const selected: Record<"source" | "target", ProductionAsset> = { source, target };
  const merged = {
    ...target,
    name: selected[choices.name].name,
    description: selected[choices.description].description,
    referenceImageId: selected[choices.referenceImageId].referenceImageId,
    needsReview: source.needsReview || target.needsReview,
  };
  const affected = new Set(workspace.assetLinks.filter(link => link.assetId === sourceId || link.assetId === targetId).map(link => link.shotId));
  return { ...workspace, shots: workspace.shots.map(shot => affected.has(shot.id) ? { ...shot, assetsNeedReview: true } : shot), assetLinks: redirectAssetLinks(workspace, sourceId, targetId), assets: workspace.assets.filter(asset => asset.id !== sourceId)
    .map(asset => asset.id === targetId ? merged : asset) };
}
