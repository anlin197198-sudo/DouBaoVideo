export const DEEPSEEK_PLANNER_MODEL = "deepseek-flash" as const;
/** The version currently documented for this hosted alias, not a pinned snapshot. */
export const DEEPSEEK_PLANNER_DOCUMENTED_VERSION = "DeepSeek-V4.1-Flash-1017" as const;
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 60_000;

const ERROR_MESSAGES = {
  DISABLED: "DeepSeek 文字策划尚未启用。",
  MISSING_KEY: "未配置有效的 DeepSeek API 密钥。",
  INVALID_INPUT: "文字策划输入为空、无效或超过单次请求限制。",
  CANCELLED: "已停止等待 DeepSeek 文字策划，不会自动重试。",
  TIMEOUT: "等待 DeepSeek 文字策划超时，不会自动重试。",
  AUTH: "DeepSeek 拒绝鉴权，请检查 API 密钥和访问权限。",
  QUOTA: "DeepSeek 余额不足或账户费用受限。",
  RATE_LIMIT: "DeepSeek 请求达到频率限制，请稍后手动重试。",
  HTTP: "DeepSeek 未接受该请求或服务暂不可用。",
  NETWORK: "未能连接 DeepSeek 或读取回复，请检查网络。",
  RESPONSE_TOO_LARGE: "DeepSeek 回复超过本地读取限制。",
  EMPTY_RESPONSE: "DeepSeek 未返回有效的策划内容。",
  TRUNCATED_RESPONSE: "DeepSeek 回复超出输出限制，未采用不完整候选。",
  INVALID_RESPONSE: "DeepSeek 回复无法识别为完整的 JSON 对象。",
} as const;

export type DeepSeekPlannerErrorCode = keyof typeof ERROR_MESSAGES;
export class DeepSeekPlannerError extends Error {
  constructor(readonly code: DeepSeekPlannerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DeepSeekPlannerError";
  }
}

export type DeepSeekPlannerRequest = { system: string; user: string; maxOutputTokens?: number };
export type DeepSeekPlannerOptions = { enabled: boolean; apiKey?: string; fetchImpl?: typeof fetch };
export type DeepSeekPlannerReadiness = {
  state: "disabled" | "missing_key" | "configured";
  model: typeof DEEPSEEK_PLANNER_MODEL;
  modelVersion: typeof DEEPSEEK_PLANNER_DOCUMENTED_VERSION;
};

export function readDeepSeekPlannerOptions(env: NodeJS.ProcessEnv = process.env): DeepSeekPlannerOptions {
  return env.DOUBAO_DEEPSEEK_ENABLED === "1"
    ? { enabled: true, apiKey: env.DEEPSEEK_API_KEY }
    : { enabled: false };
}

function validKey(key: string | undefined): string | undefined {
  const value = key?.trim();
  // Do not enforce a provider key prefix, but do not allow whitespace, control characters or an oversized header.
  return value && /^[!-~]{1,512}$/.test(value) ? value : undefined;
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function cancelBody(response: Response) {
  // Cancellation is best effort. A failing stream must never replace the original diagnostic.
  void response.body?.cancel().catch(() => {});
}

async function readResponse(response: Response): Promise<string> {
  const declaredSize = response.headers.get("content-length");
  if (declaredSize !== null && Number(declaredSize) > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw new DeepSeekPlannerError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new DeepSeekPlannerError("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const parts: string[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new DeepSeekPlannerError("RESPONSE_TOO_LARGE");
      // Do not accumulate empty chunks, even when a stream returns them.
      if (next.value.byteLength) {
        try {
          parts.push(decoder.decode(next.value, { stream: true }));
        } catch {
          throw new DeepSeekPlannerError("INVALID_RESPONSE");
        }
      }
    }
    try {
      return parts.join("") + decoder.decode();
    } catch {
      throw new DeepSeekPlannerError("INVALID_RESPONSE");
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function statusCode(status: number): DeepSeekPlannerErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return "QUOTA";
  if (status === 429) return "RATE_LIMIT";
  return "HTTP";
}

/** Main-process transport. Only call from an explicitly confirmed workflow. No provider output is applied here. */
export class DeepSeekPlanner {
  #enabled: boolean;
  #apiKey?: string;
  #fetch: typeof fetch;

  constructor(options: DeepSeekPlannerOptions) {
    this.#enabled = options.enabled === true;
    this.#apiKey = this.#enabled ? validKey(options.apiKey) : undefined;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  readiness(): DeepSeekPlannerReadiness {
    return {
      state: !this.#enabled ? "disabled" : this.#apiKey ? "configured" : "missing_key",
      model: DEEPSEEK_PLANNER_MODEL,
      modelVersion: DEEPSEEK_PLANNER_DOCUMENTED_VERSION,
    };
  }

  async generateJson(request: DeepSeekPlannerRequest, signal?: AbortSignal): Promise<string> {
    if (!this.#enabled) throw new DeepSeekPlannerError("DISABLED");
    if (!this.#apiKey) throw new DeepSeekPlannerError("MISSING_KEY");
    if (signal?.aborted) throw new DeepSeekPlannerError("CANCELLED");
    const { system, user, maxOutputTokens = MAX_OUTPUT_TOKENS } = request;
    if (typeof system !== "string" || typeof user !== "string" ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS ||
      system.length + user.length > MAX_INPUT_BYTES ||
      !system.trim() || !user.trim() ||
      Buffer.byteLength(system, "utf8") + Buffer.byteLength(user, "utf8") > MAX_INPUT_BYTES) {
      throw new DeepSeekPlannerError("INVALID_INPUT");
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.#fetch(ENDPOINT, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: requestSignal,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: DEEPSEEK_PLANNER_MODEL,
          messages: [
            { role: "system", content: `${system}\n仅输出 JSON 对象。` },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          max_tokens: maxOutputTokens,
          stream: false,
        }),
      });
      if (!response.ok || response.redirected || (response.url && response.url !== ENDPOINT)) {
        cancelBody(response);
        throw new DeepSeekPlannerError(statusCode(response.status));
      }

      const rawResponse = await readResponse(response);
      if (requestSignal.aborted) throw new DeepSeekPlannerError("CANCELLED");
      if (!rawResponse.trim()) throw new DeepSeekPlannerError("EMPTY_RESPONSE");

      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = responseObject(JSON.parse(rawResponse));
      } catch {
        throw new DeepSeekPlannerError("INVALID_RESPONSE");
      }
      const choices = envelope?.choices;
      if (!Array.isArray(choices) || choices.length !== 1) throw new DeepSeekPlannerError("INVALID_RESPONSE");
      const choice = responseObject(choices[0]);
      if (choice?.finish_reason === "length") throw new DeepSeekPlannerError("TRUNCATED_RESPONSE");
      if (choice?.finish_reason !== "stop") throw new DeepSeekPlannerError("INVALID_RESPONSE");
      const message = responseObject(choice.message);
      if (message?.role !== "assistant" ||
        (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0))) {
        throw new DeepSeekPlannerError("INVALID_RESPONSE");
      }
      const content = message.content;
      if (typeof content !== "string") throw new DeepSeekPlannerError("INVALID_RESPONSE");
      if (!content.trim()) throw new DeepSeekPlannerError("EMPTY_RESPONSE");
      try {
        if (!responseObject(JSON.parse(content))) throw new DeepSeekPlannerError("INVALID_RESPONSE");
      } catch {
        throw new DeepSeekPlannerError("INVALID_RESPONSE");
      }
      return content;
    } catch (error) {
      if (signal?.aborted) throw new DeepSeekPlannerError("CANCELLED");
      if (timeout.aborted) throw new DeepSeekPlannerError("TIMEOUT");
      if (error instanceof DeepSeekPlannerError) throw error;
      // Fetch errors and service bodies can contain account or request data. Never retain them as error causes.
      throw new DeepSeekPlannerError("NETWORK");
    }
  }
}
