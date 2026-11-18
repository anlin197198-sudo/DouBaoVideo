import { DatabaseSync } from "node:sqlite";

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE plans (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, style TEXT NOT NULL,
        start_date TEXT NOT NULL, daily_count INTEGER NOT NULL CHECK(daily_count > 0),
        execution_time TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), title TEXT NOT NULL,
        business_date TEXT NOT NULL, sequence INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 0,
        workspace_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(plan_id, business_date, sequence)
      );
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, nickname TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'unknown',
        tier_source TEXT NOT NULL DEFAULT 'unknown', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        login_state TEXT NOT NULL DEFAULT 'unknown', image_capability TEXT NOT NULL DEFAULT 'unknown',
        video_capability TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL
      );
      CREATE TABLE executions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), account_id TEXT REFERENCES accounts(id),
        operation TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL,
        remote_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX one_active_execution_per_task ON executions(task_id)
        WHERE status IN ('queued', 'submitting', 'generating', 'uncertain');
      CREATE TABLE films (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        task_id TEXT NOT NULL REFERENCES tasks(id), file_path TEXT NOT NULL,
        version INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, version)
      );
      CREATE TABLE command_receipts (
        request_id TEXT PRIMARY KEY, command TEXT NOT NULL,
        input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX tasks_plan_date ON tasks(plan_id, business_date);
    `,
  },
];

export class ApplicationDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    this.connection = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.connection.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;",
      );
      this.migrate();
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  get version(): number {
    const row = this.connection.prepare("PRAGMA user_version").get();
    return Number(row?.user_version);
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result instanceof Promise)
        throw new TypeError(
          "Database transactions require synchronous operations",
        );
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  private migrate(): void {
    const latestVersion = migrations.at(-1)!.version;
    if (this.version > latestVersion)
      throw new Error(
        "The workspace database requires a newer application version",
      );
    for (const migration of migrations) {
      if (migration.version <= this.version) continue;
      this.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }
}
