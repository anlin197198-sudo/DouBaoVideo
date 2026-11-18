import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CommandLog {
  requestId: string;
  command: string;
  outcome: "success" | "error";
  durationMs: number;
  code?: string;
}

export interface Logger {
  command(entry: CommandLog): void;
}

export class FileLogger implements Logger {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  command(entry: CommandLog): void {
    const now = new Date().toISOString();
    try {
      appendFileSync(
        join(this.directory, now.slice(0, 10) + ".jsonl"),
        JSON.stringify({ at: now, ...entry }) + "\n",
      );
    } catch {
      // A diagnostic write must not change the result of an already committed command.
      console.error(
        "Could not write command diagnostics",
        entry.requestId,
        entry.code ?? entry.outcome,
      );
    }
  }
}
