import type { TaskWorkspace } from "./models";
import { setAssetLink } from "./asset-links";

export type AssetLinkEvidenceField = "title" | "description" | "action";
export interface AssetLinkSuggestion { id: string; shotId: string; assetId: string; field: AssetLinkEvidenceField; evidence: string }
export interface AssetLinkPreview { fingerprint: string; suggestions: AssetLinkSuggestion[] }
const fields: AssetLinkEvidenceField[] = ["title", "description", "action"];
const normalize = (text: string) => text.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
const latinToken = (character: string) => /[\p{Script=Latin}\p{N}\p{M}_]/u.test(character);

/** Exact content snapshot, not a collision-prone hash. Layout/review flags are unrelated. */
function fingerprint(w: TaskWorkspace): string {
  return JSON.stringify({
    shots: w.shots.map(({ position, needsReview, assetsNeedReview, ...content }) => content),
    assets: w.assets.map(({ position, needsReview, ...content }) => content),
    links: w.assetLinks,
  });
}
function match(text: string, name: string): number {
  let start = 0;
  while (start <= text.length - name.length) {
    const index = text.indexOf(name, start); if (index < 0) return -1;
    const left = Array.from(text.slice(Math.max(0, index - 2), index)).at(-1) ?? "", right = Array.from(text.slice(index + name.length, index + name.length + 2))[0] ?? "";
    const first = Array.from(name)[0]!, last = Array.from(name).at(-1)!;
    if (!(latinToken(first) && latinToken(left)) && !(latinToken(last) && latinToken(right))) return index;
    start = index + name.length;
  }
  return -1;
}

/** Local name mentions only: no provider, generated assets, semantic inference or automatic adoption. */
export function previewAssetLinks(w: TaskWorkspace): AssetLinkPreview {
  const placeholders = new Set(["未命名人物", "未命名场景", "未命名道具"]);
  const names = w.assets.map(asset => ({ asset, name: normalize(asset.name) }));
  const counts = new Map<string, number>();
  for (const { name } of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const linked = new Set(w.assetLinks.map(link => `${link.shotId}:${link.assetId}`));
  const suggestions: AssetLinkSuggestion[] = [];
  for (const shot of w.shots) {
    const texts = fields.map(field => ({ field, text: normalize(shot[field]) }));
    for (const { asset, name } of names) {
      const id = `${shot.id}:${asset.id}`;
      if (placeholders.has(name) || linked.has(id) || Array.from(name).length < 2 || !/[\p{L}\p{N}]/u.test(name) || counts.get(name) !== 1) continue;
      for (const { field, text } of texts) {
        const at = match(text, name); if (at < 0) continue;
        const before = Array.from(text.slice(0, at)).slice(-24).join("");
        const after = Array.from(text.slice(at + name.length)).slice(0, 24).join("");
        suggestions.push({ id, shotId: shot.id, assetId: asset.id, field, evidence: `${at > before.length ? "…" : ""}${before}${name}${after}${at + name.length + after.length < text.length ? "…" : ""}` });
        break; // One suggestion per pair; prefer title, then description, then action.
      }
    }
  }
  return { fingerprint: fingerprint(w), suggestions };
}

/** Reject the entire stale/invalid batch before any additions; manual links are never removed. */
export function adoptAssetLinkSuggestions(w: TaskWorkspace, preview: AssetLinkPreview, selectedIds: string[]): TaskWorkspace {
  const current = previewAssetLinks(w);
  if (current.fingerprint !== preview.fingerprint) throw new Error("镜头、资产或手动关联已变化，请刷新建议后重新选择。");
  const available = new Map(current.suggestions.map(suggestion => [suggestion.id, suggestion]));
  const selected = [...new Set(selectedIds)];
  if (selected.some(id => !available.has(id))) throw new Error("所选建议已不存在，请刷新建议后重新选择。");
  let next = w;
  for (const id of selected) { const item = available.get(id)!; next = setAssetLink(next, item.assetId, item.shotId, true); }
  return next;
}
