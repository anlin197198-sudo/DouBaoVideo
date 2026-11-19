import assert from "node:assert/strict";
import test from "node:test";
import {
  DeepSeekPlanner,
  DeepSeekPlannerError,
  readDeepSeekPlannerOptions,
  type DeepSeekPlannerErrorCode,
} from "../src/main/providers/deepseek-planner";

const fakeKey = "test-only-fake-key";
const request = { system: "生成分镜", user: "合成测试场景" };
const badContent = "secret-private-payload";

function reply(content: unknown, finishReason = "stop"): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { role: "assistant", content } }] });
}

function isCode(code: DeepSeekPlannerErrorCode) {
  return (error: unknown) => {
    assert(error instanceof DeepSeekPlannerError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /secret-private-payload|test-only-fake-key/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("DeepSeek planner stays disabled unless explicitly opted in; readiness never includes key", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { ++requests; return reply("{}"); };
  for (const flag of [undefined, "true", "0", " 1", "1 "]) {
    const config = readDeepSeekPlannerOptions({ DOUBAO_DEEPSEEK_ENABLED: flag, DEEPSEEK_API_KEY: fakeKey });
    assert.deepEqual(config, { enabled: false });
    const planner = new DeepSeekPlanner({ ...config, fetchImpl });
    assert.deepEqual(planner.readiness(), {
      state: "disabled", model: "deepseek-flash", modelVersion: "DeepSeek-V4.1-Flash-1017",
    });
    await assert.rejects(planner.generateJson(request), isCode("DISABLED"));
  }
  for (const apiKey of [undefined, "", " ", "bad\nsecret", "x".repeat(513)]) {
    const config = readDeepSeekPlannerOptions({ DOUBAO_DEEPSEEK_ENABLED: "1", DEEPSEEK_API_KEY: apiKey });
    const planner = new DeepSeekPlanner({ ...config, fetchImpl });
    assert.equal(planner.readiness().state, "missing_key");
    await assert.rejects(planner.generateJson(request), isCode("MISSING_KEY"));
  }
  assert.equal(requests, 0);
});

test("DeepSeek planner posts one redirection-blocked request to official JSON text endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply('{"shots":[]}');
  };
  const planner = new DeepSeekPlanner({ enabled: true, apiKey: fakeKey, fetchImpl });
  assert.equal(await planner.generateJson(request), '{"shots":[]}');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.equal(init?.cache, "no-store");
  assert.equal(init?.credentials, "omit");
  assert(init?.signal instanceof AbortSignal);
  assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${fakeKey}`);
  assert.deepEqual(JSON.parse(String(init?.body)), {
    model: "deepseek-flash",
    messages: [{ role: "system", content: "生成分镜\n仅输出 JSON 对象。" }, { role: "user", content: request.user }],
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    max_tokens: 8192,
    stream: false,
  });
  assert.doesNotMatch(JSON.stringify(planner), /test-only-fake-key/);
});

test("DeepSeek planner rejects blank and oversized UTF-8 input and pre-aborted requests without sending", async () => {
  let requests = 0;
  const planner = new DeepSeekPlanner({
    enabled: true, apiKey: fakeKey, fetchImpl: async () => { ++requests; return reply("{}"); },
  });
  await assert.rejects(planner.generateJson({ ...request, user: " " }), isCode("INVALID_INPUT"));
  await assert.rejects(planner.generateJson({ ...request, user: "镜".repeat(45_000) }), isCode("INVALID_INPUT"));
  await assert.rejects(planner.generateJson({ ...request, user: "x".repeat(135_000) }), isCode("INVALID_INPUT"));
  await assert.rejects(planner.generateJson(request, AbortSignal.abort(badContent)), isCode("CANCELLED"));
  assert.equal(requests, 0);
});

test("DeepSeek planner redacts HTTP and network errors and never automatically retries", async () => {
  for (const [status, code] of [[401, "AUTH"], [403, "AUTH"], [402, "QUOTA"], [429, "RATE_LIMIT"], [302, "HTTP"], [500, "HTTP"]] as const) {
    let requests = 0;
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const planner = new DeepSeekPlanner({
      enabled: true, apiKey: fakeKey, fetchImpl: async () => {
        ++requests;
        return new Response(body, { status, headers: { Location: "https://example.invalid/" } });
      },
    });
    await assert.rejects(planner.generateJson(request), isCode(code));
    assert.equal(requests, 1);
    assert.equal(cancelled, true);
  }
  const planner = new DeepSeekPlanner({
    enabled: true, apiKey: fakeKey, fetchImpl: async () => { throw new Error(badContent); },
  });
  await assert.rejects(planner.generateJson(request), isCode("NETWORK"));
});

test("DeepSeek planner rejects incomplete, blank, malformed or unexpected tool replies", async () => {
  const cases: Array<[Response, DeepSeekPlannerErrorCode]> = [
    [reply("   "), "EMPTY_RESPONSE"],
    [new Response(""), "EMPTY_RESPONSE"],
    [reply('{"shots":', "length"), "TRUNCATED_RESPONSE"],
    [reply(badContent), "INVALID_RESPONSE"],
    [reply("[]"), "INVALID_RESPONSE"],
    [reply("{}", "tool_calls"), "INVALID_RESPONSE"],
    [new Response(badContent), "INVALID_RESPONSE"],
    [new Response(new Uint8Array([0xff])), "INVALID_RESPONSE"],
    [Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", tool_calls: [{}] } }] }), "INVALID_RESPONSE"],
  ];
  for (const [response, code] of cases) {
    const planner = new DeepSeekPlanner({ enabled: true, apiKey: fakeKey, fetchImpl: async () => response });
    await assert.rejects(planner.generateJson(request), isCode(code));
  }
});

test("DeepSeek planner enforces declared and streamed response ceilings", async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(new DeepSeekPlanner({
    enabled: true, apiKey: fakeKey, fetchImpl: async () => new Response(oversized),
  }).generateJson(request), isCode("RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
  await assert.rejects(new DeepSeekPlanner({
    enabled: true, apiKey: fakeKey,
    fetchImpl: async () => new Response("{}", { headers: { "content-length": "3000000" } }),
  }).generateJson(request), isCode("RESPONSE_TOO_LARGE"));
});

test("DeepSeek planner passes cancellation and fixed timeout to fetch without reporting abort reason", async (t) => {
  const external = new AbortController();
  let forwardedSignal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    forwardedSignal = init?.signal;
    assert(forwardedSignal);
    forwardedSignal.addEventListener("abort", () => reject(forwardedSignal?.reason), { once: true });
  });
  const planner = new DeepSeekPlanner({ enabled: true, apiKey: fakeKey, fetchImpl });
  const pending = planner.generateJson(request, external.signal);
  external.abort(badContent);
  await assert.rejects(pending, isCode("CANCELLED"));
  assert.equal(forwardedSignal?.aborted, true);

  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (value: number) => {
    assert.equal(value, 60_000);
    return timeout.signal;
  });
  const delayed = planner.generateJson(request);
  timeout.abort(badContent);
  await assert.rejects(delayed, isCode("TIMEOUT"));
});
