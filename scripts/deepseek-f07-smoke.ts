import { pathToFileURL } from "node:url";
import {
  DEEPSEEK_PLANNER_MODEL,
  DeepSeekPlanner,
  readDeepSeekPlannerOptions,
} from "../src/main/providers/deepseek-planner";
import { StoryboardCandidateSession } from "../src/shared/storyboard-candidate";

export const DEEPSEEK_F07_SMOKE_ACK = "--confirm-one-billable-request";

const syntheticRequest = {
  system: [
    '输出紧凑 JSON，不加 Markdown，恰好两个分镜，order 为 1 和 2。',
    '对象示例：{"formatVersion":1,"shots":[{"order":1,"title":"开场","visual":"桌上的蓝杯","action":"","framing":"特写","motion":"固定","dialogue":""}]}。',
    '仅使用示例字段，值尽量简短。不要补写对白、场景或人物。',
  ].join("\n"),
  user: "镜头一：桌上放着蓝杯。镜头二：手把蓝杯移到白纸上。无对白。",
  maxOutputTokens: 256,
} as const;

type SmokeResult = {
  result: "PASS" | "FAIL";
  model: typeof DEEPSEEK_PLANNER_MODEL;
  validatedShotCount: number;
};

export async function runDeepSeekF07Smoke(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): Promise<SmokeResult> {
  const result = (ok: boolean, count = 0): SmokeResult => ({
    result: ok ? "PASS" : "FAIL", model: DEEPSEEK_PLANNER_MODEL, validatedShotCount: count,
  });
  if (args.length !== 1 || args[0] !== DEEPSEEK_F07_SMOKE_ACK || env.DOUBAO_DEEPSEEK_SMOKE !== "1")
    return result(false);

  try {
    const planner = new DeepSeekPlanner({ ...readDeepSeekPlannerOptions(env), fetchImpl });
    if (planner.readiness().state !== "configured") return result(false);
    const candidate = new StoryboardCandidateSession(await planner.generateJson(syntheticRequest));
    try {
      const status = candidate.status;
      const count = status.status === "ready" ? status.shotCount : 0;
      return result(count === 2, count);
    } finally {
      candidate.discard();
    }
  } catch {
    // Do not report exceptions, provider replies or credential configuration.
    return result(false);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDeepSeekF07Smoke(process.argv.slice(2), process.env).then(outcome => {
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    process.exitCode = outcome.result === "PASS" ? 0 : 1;
  });
}
