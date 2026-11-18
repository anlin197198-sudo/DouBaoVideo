import { z } from "zod";

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00.000Z");
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
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
    script: z.string().max(100000, "剧本内容过长"),
    scriptPosition: position,
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().min(0.1).max(4),
      })
      .strict(),
  })
  .strict();

export const requestEnvelope = z
  .object({
    requestId: identifier,
    command: z.string().min(1).max(80),
    input: z.unknown(),
  })
  .strict();

export const commandSchemas = {
  "app.info": z.object({}).strict(),
  "workspace.read": z.object({}).strict(),
  "plans.create": z
    .object({
      title,
      style: z.enum(["realistic", "comic"]),
      startDate: z.string().refine(isCalendarDate, "请选择有效日期"),
      dailyCount: z.number().int().min(1, "每天至少安排一条任务"),
      executionTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "请选择有效执行时间"),
    })
    .strict(),
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
};
