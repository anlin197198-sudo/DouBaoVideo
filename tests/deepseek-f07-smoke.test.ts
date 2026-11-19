import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSEEK_F07_SMOKE_ACK,
  runDeepSeekF07Smoke,
} from "../scripts/deepseek-f07-smoke";

const ack = [DEEPSEEK_F07_SMOKE_ACK];
const env = {
  DOUBAO_DEEPSEEK_ENABLED: "1",
  DOUBAO_DEEPSEEK_SMOKE: "1",
  DEEPSEEK_API_KEY: "mock-not-a-real-key",
};
const shot = { order: 1, title: "测试", visual: "", action: "", framing: "", motion: "", dialogue: "" };
const expected = (result: "PASS" | "FAIL", validatedShotCount = 0) => ({
  result, model: "deepseek-flash", validatedShotCount,
});
function reply(object: unknown) {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(object) } }],
  });
}

test("live smoke cannot call the injected transport without unique acknowledgement and both opt-in flags", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { ++calls; throw new Error("must not fetch"); };
  for (const [args, config] of [
    [[], env],
    [[...ack, "--extra"], env],
    [ack, { ...env, DOUBAO_DEEPSEEK_ENABLED: "0" }],
    [ack, { ...env, DOUBAO_DEEPSEEK_SMOKE: "0" }],
    [ack, { ...env, DEEPSEEK_API_KEY: undefined }],
  ] as const)
    assert.deepEqual(await runDeepSeekF07Smoke(args, config, fetchImpl), expected("FAIL"));
  assert.equal(calls, 0);
});

test("live smoke uses one small synthetic request and the F07 validator", async () => {
  let calls = 0;
  const output = await runDeepSeekF07Smoke(ack, env, async (url, init) => {
    ++calls;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.max_tokens, 256);
    assert.equal(payload.model, "deepseek-flash");
    assert.match(payload.messages[1].content, /蓝杯/);
    return reply({ formatVersion: 1, shots: [shot, { ...shot, order: 2 }] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(output, expected("PASS", 2));
});

test("live smoke emits no raw reply or error and never retries wrong or rejected results", async () => {
  let calls = 0;
  for (const [mock, result] of [
    [() => reply({ formatVersion: 1, shots: [shot, { ...shot, order: 3 }] }), expected("FAIL")],
    [() => reply({ formatVersion: 1, shots: [shot] }), expected("FAIL", 1)],
    [() => { throw new Error("synthetic-secret-error"); }, expected("FAIL")],
  ] as const) {
    const outcome = await runDeepSeekF07Smoke(ack, env, async () => { ++calls; return mock(); });
    assert.deepEqual(outcome, result);
    assert.doesNotMatch(JSON.stringify(outcome), /synthetic-secret-error|测试|mock-not-a-real-key/);
  }
  assert.equal(calls, 3);
});

test("transport rejects invalid optional output caps without touching the mock HTTP layer", async () => {
  const { DeepSeekPlanner, DeepSeekPlannerError } = await import("../src/main/providers/deepseek-planner");
  const planner = new DeepSeekPlanner({
    enabled: true, apiKey: env.DEEPSEEK_API_KEY,
    fetchImpl: async () => { assert.fail("must not fetch"); },
  });
  for (const maxOutputTokens of [0, -1, 8193, 2.3, Infinity])
    await assert.rejects(planner.generateJson({ system: "测试", user: "测试", maxOutputTokens }),
      (error: unknown) => error instanceof DeepSeekPlannerError && error.code === "INVALID_INPUT");
});
