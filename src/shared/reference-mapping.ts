import { z } from "zod";
import type { PromptKind, TaskWorkspace } from "./models";
import type { PlanStyleContext } from "./prompts";

export interface ReferenceMappingContext {
  taskId: string; revision: number; workspace: TaskWorkspace; plan: PlanStyleContext;
  kind: PromptKind; shotId: string | null; templateText: string;
}
export interface ReferenceMappingRow { readonly imageId: string; readonly assets: readonly { readonly id: string; readonly name: string; readonly type: string }[] }
const invalid = () => new Error("临时参考图编号无效或来源已变化，请重新开始。");
function snapshot(context: ReferenceMappingContext) {
  if (!z.string().uuid().safeParse(context.taskId).success || !Number.isSafeInteger(context.revision) || context.revision < 0 || typeof context.templateText !== "string") throw invalid();
  const { workspace: w, kind, shotId } = context;
  if (!["shot", "video", "firstFrame", "lastFrame"].includes(kind) || (kind !== "shot" && shotId !== null)) throw invalid();
  const selected = kind === "shot" ? w.shots.filter(s => s.id === shotId) : kind === "firstFrame" ? w.shots.slice(0, 1) : kind === "lastFrame" ? w.shots.slice(-1) : w.shots;
  if (kind === "shot" && selected.length !== 1) throw invalid();
  const ids = new Set(selected.map(s => s.id));
  const linked = new Set(w.assetLinks.filter(l => ids.has(l.shotId)).map(l => l.assetId));
  const rows = new Map<string, { id: string; name: string; type: string }[]>();
  for (const asset of w.assets.filter(a => linked.has(a.id) && a.referenceImageId)) {
    if (!z.string().uuid().safeParse(asset.referenceImageId).success) throw invalid();
    const list = rows.get(asset.referenceImageId!) ?? [];
    list.push({ id: asset.id, name: asset.name, type: asset.type }); rows.set(asset.referenceImageId!, list);
  }
  return { fingerprint: JSON.stringify(context), rows: Object.freeze([...rows].map(([imageId, assets]) => Object.freeze({ imageId, assets: Object.freeze(assets.map(a => Object.freeze(a))) }))) };
}
/** Author declarations only. No file verification, provider numbering, draft application or persistence.
 * Call observe for every displayed context change; invalidation is sticky even on A -> B -> A. */
export class ReferenceMappingSession {
  #fingerprint: string; #stale = false; #indices = new Map<string, number>();
  readonly rows: readonly ReferenceMappingRow[];
  constructor(context: ReferenceMappingContext) { const s = snapshot(context); this.#fingerprint = s.fingerprint; this.rows = s.rows; }
  observe(context: ReferenceMappingContext): boolean {
    try { if (snapshot(context).fingerprint !== this.#fingerprint) this.#stale = true; } catch { this.#stale = true; }
    return !this.#stale;
  }
  update(context: ReferenceMappingContext, imageId: string, index: number | null): void {
    if (!this.observe(context) || !this.rows.some(r => r.imageId === imageId) ||
      (index !== null && (!Number.isInteger(index) || index < 1 || index > 200 || [...this.#indices].some(([id, n]) => id !== imageId && n === index)))) throw invalid();
    if (index === null) this.#indices.delete(imageId); else this.#indices.set(imageId, index);
  }
  preview(context: ReferenceMappingContext) {
    const current = this.observe(context);
    const entries = current ? this.rows.filter(r => this.#indices.has(r.imageId)).map(r => Object.freeze({ ...r, index: this.#indices.get(r.imageId)! })) : [];
    return Object.freeze({ current, entries: Object.freeze(entries), text: !current || !entries.length ? "" :
      [context.templateText, "", "作者临时计划编号（仅本地声明；未上传、未验证文件或提供方对应关系）", ...entries.map(r => `计划 @图片${r.index}（本地图片 ID：${r.imageId}）：${r.assets.map(a => `${a.type === "person" ? "人物" : a.type === "scene" ? "场景" : "道具"}：${a.name}`).join("；")}`),
        "未填写的参考图保持未指定。以上编号不替代原文中的未知上传关系，也不代表可以发送。"].join("\n"),
      canSubmit: false as const, applied: false as const });
  }
}
