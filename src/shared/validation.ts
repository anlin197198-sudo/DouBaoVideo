import { z } from "zod";
import { uniqueAssetLinks } from "./asset-links";

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00.000Z");
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isWeekStart(value: string): boolean {
  if (!isCalendarDate(value)) return false;
  const end = new Date(value + "T12:00:00.000Z");
  end.setUTCDate(end.getUTCDate() + 6);
  return isCalendarDate(end.toISOString().slice(0, 10));
}

const identifier = z.uuid();
const title = z
  .string()
  .trim()
  .min(1, "请输入名称")
  .max(120, "名称最多 120 个字符");
const tier = z.enum(["unknown", "free", "standard", "plus", "premium"]);
const position = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
const workspace = z
  .object({
    productionPositions: z.record(z.string().regex(/^(prompt:(video|firstFrame|lastFrame|shot:[0-9a-f-]{36})|frame:(first|last))$/), position)
      .refine(value => Object.keys(value).length <= 205, "制作节点位置过多").optional(),
    frames: z.object({
      candidates: z.array(z.object({ id: identifier, imageId: identifier, slot: z.enum(["first", "last"]), source: z.literal("import"),
        createdAt: z.iso.datetime(), promptText: z.string().max(100000), promptVersion: z.number().int().positive().nullable(),
        inputSnapshot: z.string().max(10000000) }).strict()).max(100),
      firstId: identifier.nullable(), lastId: identifier.nullable(),
      parameters: z.object({ aspectRatio: z.enum(["16:9", "9:16", "1:1"]), durationSeconds: z.union([z.literal(5), z.literal(10)]) }).strict(),
      confirmation: z.object({ inputSnapshot: z.string().max(20000000), confirmedAt: z.iso.datetime(), invalidated: z.boolean() }).strict().nullable(),
    }).strict().refine(frames => new Set(frames.candidates.map(candidate => candidate.id)).size === frames.candidates.length, "候选标识不能重复")
      .refine(frames => (!frames.firstId || frames.candidates.some(candidate => candidate.id === frames.firstId && candidate.slot === "first"))
        && (!frames.lastId || frames.candidates.some(candidate => candidate.id === frames.lastId && candidate.slot === "last")), "当前图必须对应正确位置的候选").optional(),
    promptSettings: z.object({ style: z.enum(["realistic", "comic"]).nullable(), notes: z.string().max(5000), notesMode: z.enum(["inherit", "override"]).optional() }).strict().optional(),
    prompts: z.array(z.object({ kind: z.enum(["shot", "video", "firstFrame", "lastFrame"]),
      shotId: identifier.nullable(), text: z.string().max(100000), version: z.number().int().positive(),
      inputSnapshot: z.string().max(10000000), source: z.literal("manual") }).strict()).max(203).optional(),
    script: z.string().max(100000, "剧本内容过长"),
    scriptPosition: position,
    assetLinks: z.array(z.object({ shotId: identifier, assetId: identifier }).strict()).max(40000).default([]),
    assets: z.array(z.object({
      id: identifier,
      type: z.enum(["person", "scene", "prop"]),
      name: title,
      description: z.string().max(10000, "资产设定最多 10000 个字符"),
      referenceImageId: identifier.nullable(),
      version: z.number().int().positive(),
      position,
      needsReview: z.boolean(),
    }).strict()).max(200, "一条任务最多保留 200 项资产")
      .refine(assets => new Set(assets.map(asset => asset.id)).size === assets.length,
        "资产标识不能重复"),
    shots: z.array(z.object({
      id: identifier,
      title: z.string().trim().min(1, "请输入镜头名称").max(120),
      description: z.string().max(10000),
      action: z.string().max(10000),
      shotSize: z.string().max(120),
      cameraMovement: z.string().max(500),
      audio: z.string().max(10000),
      assetsNeedReview: z.boolean().optional(),
      position,
      needsReview: z.boolean(),
    }).strict()).max(200, "一条任务最多保留 200 个镜头")
      .refine(shots => new Set(shots.map(shot => shot.id)).size === shots.length,
        "镜头标识不能重复"),
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().min(0.1).max(4),
      })
      .strict(),
  })
  .strict()
  .refine(value => (value.prompts ?? []).every(prompt => prompt.kind === "shot"
    ? value.shots.some(shot => shot.id === prompt.shotId) : prompt.shotId === null), "提示词必须属于当前任务的镜头或整体内容")
  .refine(value => new Set((value.prompts ?? []).map(prompt => `${prompt.kind}:${prompt.shotId}`)).size === (value.prompts ?? []).length,
    "同一类型提示词不能重复")
  .refine(value => {
    const shotIds = new Set(value.shots.map(shot => shot.id));
    return value.assets.every(asset => !shotIds.has(asset.id));
  }, "资产和镜头不能使用相同的标识")
  .refine(value => value.assetLinks.every(link =>
    value.shots.some(shot => shot.id === link.shotId) && value.assets.some(asset => asset.id === link.assetId)),
    "关联必须引用当前任务中的镜头和资产")
  .transform(value => ({ ...value, assetLinks: uniqueAssetLinks(value.assetLinks) }));

export const requestEnvelope = z
  .object({
    requestId: identifier,
    command: z.string().min(1).max(80),
    input: z.unknown(),
  })
  .strict();

const planFields = z
    .object({
      styleNotes: z.string().max(5000).optional(),
      title,
      style: z.enum(["realistic", "comic"]),
      startDate: z.string().refine(isWeekStart, "请选择有效日期，完整 7 天必须在四位年份范围内"),
      dailyCount: z.number().int().min(1, "每天至少安排一条任务").max(100, "本地安全上限为每天 100 条，一周最多 700 条"),
      executionTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "请选择有效执行时间"),
    })
    .strict();

export const commandSchemas = {
  "prompts.historyList": z.object({ taskId: identifier, kind: z.enum(["shot", "video", "firstFrame", "lastFrame"]), shotId: identifier.nullable(),
    beforeVersion: z.number().int().positive().optional(), limit: z.number().int().min(1).max(30).optional() }).strict()
    .refine(value => value.kind === "shot" ? value.shotId !== null : value.shotId === null, "提示词历史位置无效"),
  "prompts.historyDetail": z.object({ taskId: identifier, kind: z.enum(["shot", "video", "firstFrame", "lastFrame"]), shotId: identifier.nullable(),
    version: z.number().int().positive() }).strict()
    .refine(value => value.kind === "shot" ? value.shotId !== null : value.shotId === null, "提示词历史位置无效"),
  "app.info": z.object({}).strict(),
  "workspace.read": z.object({}).strict(),
  "workspace.backup": z.object({}).strict(),
  "workspace.verifyBackup": z.object({}).strict(),
  "plans.create": planFields,
  "plans.previewEdit": z.object({ id: identifier, changes: planFields }).strict(),
  "plans.applyEdit": z.object({ id: identifier, changes: planFields, previewToken: z.string().regex(/^[a-f0-9]{64}$/),
    removeTaskIds: z.array(identifier).refine(ids => new Set(ids).size === ids.length, "不能重复选择任务") }).strict(),
  "plans.setEnabled": z
    .object({ id: identifier, enabled: z.boolean() })
    .strict(),
  "tasks.saveWorkspace": z
    .object({
      id: identifier,
      expectedRevision: z.number().int().nonnegative(),
      workspace,
    })
    .strict(),
  "accounts.create": z.object({ nickname: title }).strict(),
  "accounts.update": z
    .object({ id: identifier, nickname: title, tier, enabled: z.boolean() })
    .strict(),
  "accounts.openLogin": z.object({ id: identifier }).strict(),
  "assets.importReference": z.object({ taskId: identifier }).strict(),
  "tasks.confirmFrames": z.object({ id: identifier, expectedRevision: z.number().int().nonnegative() }).strict(),
};
