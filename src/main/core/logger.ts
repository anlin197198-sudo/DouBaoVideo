import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { commandSchemas } from "../../shared/validation";

export interface CommandLog {
  requestId: string;
  command: string;
  outcome: "success" | "error";
  durationMs: number;
  code?: string;
}
export interface Logger { command(entry: CommandLog): void }
const commands = new Set(Object.keys(commandSchemas));
const codes = new Set(["INVALID_INPUT", "UNAUTHORIZED", "NOT_FOUND", "CONFLICT", "STORAGE_ERROR", "PROVIDER_UNAVAILABLE", "INTERNAL_ERROR"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strict projection, never spreading/stringifying the caller's object or its toJSON. */
export function sanitizeCommandLog(raw: unknown): CommandLog {
  const fallback: CommandLog = { requestId: randomUUID(), command: "invalid", outcome: "error", code: "INTERNAL_ERROR", durationMs: 0 };
  try {
    if (!raw || typeof raw !== "object") return fallback;
    const input = raw as Record<string, unknown>;
    const requestId = input.requestId, command = input.command, outcome = input.outcome, duration = input.durationMs, code = input.code;
    return {
      requestId: typeof requestId === "string" && uuid.test(requestId) ? requestId : fallback.requestId,
      command: typeof command === "string" && commands.has(command) ? command : "invalid",
      outcome: outcome === "success" ? "success" : "error",
      durationMs: typeof duration === "number" && Number.isFinite(duration) ? Math.round(Math.min(86400000, Math.max(0, duration))) : 0,
      ...(outcome === "success" ? {} : { code: typeof code === "string" && codes.has(code) ? code : "INTERNAL_ERROR" }),
    };
  } catch { return fallback; }
}
export class FileLogger implements Logger {
  constructor(private readonly directory: string) {}
  command(entry: CommandLog): void {
    const safe = sanitizeCommandLog(entry), now = new Date().toISOString();
    try {
      // Diagnostics-only path failures must not prevent the workspace from starting.
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(join(this.directory, now.slice(0, 10) + ".jsonl"), JSON.stringify({ at: now, ...safe }) + "\n");
    } catch {
      try { console.error("Could not write command diagnostics", safe.requestId, safe.command, safe.code ?? safe.outcome); }
      catch { /* Even a broken stderr is never a business-command failure. */ }
    }
  }
}
