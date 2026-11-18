import { createHash, randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import type {
  CommandInputs,
  CommandName,
  CommandOutputs,
  CommandResult,
} from "../../shared/bridge";
import { commandSchemas, requestEnvelope } from "../../shared/validation";
import type { ApplicationDatabase } from "../infrastructure/database";
import type { Logger } from "../core/logger";
import { ApplicationError, normalizeError } from "../core/errors";

interface Route {
  schema: ZodType;
  transactional: boolean;
  execute(input: unknown): unknown;
}

export interface SenderContext {
  trusted: boolean;
}

export class CommandRouter {
  private readonly routes = new Map<string, Route>();

  constructor(
    private readonly database: ApplicationDatabase,
    private readonly logger: Logger,
  ) {}

  register<K extends CommandName>(
    command: K,
    handler: (
      input: CommandInputs[K],
    ) => CommandOutputs[K] | Promise<CommandOutputs[K]>,
    options: { transactional?: boolean } = {},
  ): void {
    if (this.routes.has(command))
      throw new Error(`Duplicate command: ${command}`);
    this.routes.set(command, {
      schema: commandSchemas[command],
      transactional: options.transactional ?? false,
      execute: (input) => handler(input as CommandInputs[K]),
    });
  }

  async dispatch(
    rawRequest: unknown,
    sender: SenderContext,
  ): Promise<CommandResult<unknown>> {
    const startedAt = performance.now();
    let requestId: string = randomUUID();
    let command = "invalid";
    try {
      if (!sender.trusted)
        throw new ApplicationError(
          "UNAUTHORIZED",
          "当前窗口没有执行这个操作的权限。",
        );
      const envelope = requestEnvelope.safeParse(rawRequest);
      if (!envelope.success)
        throw new ApplicationError(
          "INVALID_INPUT",
          "请求格式无效，请重新操作。",
        );
      requestId = envelope.data.requestId;
      const route = this.routes.get(envelope.data.command);
      if (!route)
        throw new ApplicationError("INVALID_INPUT", "这个操作尚未注册。");
      command = envelope.data.command;
      const parsed = route.schema.safeParse(envelope.data.input);
      if (!parsed.success) {
        throw new ApplicationError(
          "INVALID_INPUT",
          parsed.error.issues[0]?.message ?? "请检查输入内容。",
        );
      }
      const data = route.transactional
        ? this.executeMutation(requestId, command, parsed.data, route)
        : await route.execute(parsed.data);
      this.logger.command({
        requestId,
        command,
        outcome: "success",
        durationMs: performance.now() - startedAt,
      });
      return { ok: true, data, requestId };
    } catch (error) {
      const normalized = normalizeError(error);
      this.logger.command({
        requestId,
        command,
        outcome: "error",
        code: normalized.code,
        durationMs: performance.now() - startedAt,
      });
      return {
        ok: false,
        error: { code: normalized.code, message: normalized.message },
        requestId,
      };
    }
  }

  private executeMutation(
    requestId: string,
    command: string,
    input: unknown,
    route: Route,
  ): unknown {
    const inputHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    return this.database.transaction(() => {
      const db = this.database.connection;
      const receipt = db
        .prepare("SELECT * FROM command_receipts WHERE request_id = ?")
        .get(requestId);
      if (receipt) {
        if (receipt.command !== command || receipt.input_hash !== inputHash) {
          throw new ApplicationError(
            "CONFLICT",
            "请求编号已经用于其他内容，请重新发起操作。",
          );
        }
        return JSON.parse(String(receipt.result_json)) as unknown;
      }
      const result = route.execute(input);
      if (result instanceof Promise)
        throw new Error("Transactional handlers must finish synchronously");
      db.prepare("INSERT INTO command_receipts VALUES (?, ?, ?, ?, ?)").run(
        requestId,
        command,
        inputHash,
        JSON.stringify(result),
        new Date().toISOString(),
      );
      return result;
    });
  }
}
