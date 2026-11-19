import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

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
  {
    version: 2,
    sql: `
      CREATE TABLE reference_images (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        original_name TEXT NOT NULL, file_name TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL, width INTEGER NOT NULL CHECK(width > 0),
        height INTEGER NOT NULL CHECK(height > 0), created_at TEXT NOT NULL,
        UNIQUE(task_id, content_hash)
      );
      CREATE INDEX reference_images_task ON reference_images(task_id);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN schedule_active INTEGER NOT NULL DEFAULT 1 CHECK(schedule_active IN (0,1));
      ALTER TABLE tasks ADD COLUMN execution_time TEXT;
      UPDATE tasks SET execution_time = (SELECT execution_time FROM plans WHERE plans.id = tasks.plan_id);
    `,
  },
  { version: 4, sql: "ALTER TABLE plans ADD COLUMN style_notes TEXT NOT NULL DEFAULT '';" },
  { version: 5, sql: `
    CREATE TABLE prompt_history (
      task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
      shot_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
      text TEXT NOT NULL, input_snapshot TEXT NOT NULL, recorded_at TEXT NOT NULL,
      record_type TEXT NOT NULL CHECK(record_type IN ('baseline','saved')),
      PRIMARY KEY(task_id, kind, shot_key, version)
    );
    CREATE TRIGGER prompt_history_no_update BEFORE UPDATE ON prompt_history
      BEGIN SELECT RAISE(ABORT, 'Prompt history is immutable'); END;
    CREATE TRIGGER prompt_history_no_delete BEFORE DELETE ON prompt_history
      BEGIN SELECT RAISE(ABORT, 'Prompt history is immutable'); END;
  ` },
  { version: 6, sql: `
    CREATE TABLE script_history (
      task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version > 0),
      text TEXT NOT NULL CHECK(typeof(text)='text' AND length(text) <= 100000), recorded_at TEXT NOT NULL,
      record_type TEXT NOT NULL CHECK(record_type IN ('baseline','saved')),
      PRIMARY KEY(task_id, version)
    );
    CREATE TRIGGER script_history_no_update BEFORE UPDATE ON script_history
      BEGIN SELECT RAISE(ABORT, 'Script history is immutable'); END;
    CREATE TRIGGER script_history_no_delete BEFORE DELETE ON script_history
      BEGIN SELECT RAISE(ABORT, 'Script history is immutable'); END;
  ` },
  { version: 7, sql: `
    CREATE TABLE account_removal (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision >= 0),
      state TEXT NOT NULL DEFAULT 'present' CHECK(state IN ('present','pending','removed')),
      operation_id TEXT, lease_token TEXT, released_token TEXT,
      CHECK((state='present' AND operation_id IS NULL AND lease_token IS NULL AND released_token IS NULL)
        OR (state='pending' AND operation_id IS NOT NULL)
        OR (state='removed' AND operation_id IS NOT NULL AND lease_token IS NOT NULL))
    );
    INSERT INTO account_removal(account_id) SELECT id FROM accounts;
    CREATE TRIGGER removal_account_created AFTER INSERT ON accounts BEGIN
      INSERT INTO account_removal(account_id) VALUES (NEW.id); END;
    CREATE TRIGGER removal_account_changed AFTER UPDATE ON accounts BEGIN
      UPDATE account_removal SET revision=revision+1 WHERE account_id=NEW.id; END;
    CREATE TRIGGER removal_account_enable_guard BEFORE UPDATE OF enabled ON accounts
      WHEN NEW.enabled=1 AND EXISTS(SELECT 1 FROM account_removal WHERE account_id=NEW.id AND state!='present')
      BEGIN SELECT RAISE(ABORT,'Account removal prevents enabling'); END;
    CREATE TRIGGER removal_account_delete_guard BEFORE DELETE ON accounts
      WHEN EXISTS(SELECT 1 FROM account_removal WHERE account_id=OLD.id AND state!='present')
      BEGIN SELECT RAISE(ABORT,'Account removal retains identity'); END;
    CREATE TRIGGER removal_execution_insert_guard BEFORE INSERT ON executions
      WHEN EXISTS(SELECT 1 FROM account_removal WHERE account_id=NEW.account_id AND state!='present')
      BEGIN SELECT RAISE(ABORT,'Account removal prevents dispatch'); END;
    CREATE TRIGGER removal_execution_update_guard BEFORE UPDATE ON executions
      WHEN EXISTS(SELECT 1 FROM account_removal WHERE account_id=NEW.account_id AND state!='present')
        AND (NEW.account_id IS NOT OLD.account_id OR (NEW.status IS NOT OLD.status AND NEW.status!='completed'))
      BEGIN SELECT RAISE(ABORT,'Account removal prevents reassignment or restart'); END;
    CREATE TRIGGER removal_execution_insert AFTER INSERT ON executions BEGIN
      UPDATE account_removal SET revision=revision+1 WHERE account_id=NEW.account_id; END;
    CREATE TRIGGER removal_execution_update AFTER UPDATE ON executions BEGIN
      UPDATE account_removal SET revision=revision+1 WHERE account_id=NEW.account_id OR account_id=OLD.account_id; END;
    CREATE TRIGGER removal_execution_delete AFTER DELETE ON executions BEGIN
      UPDATE account_removal SET revision=revision+1 WHERE account_id=OLD.account_id; END;
  ` },
];

const baselinePrompt = z.object({ kind: z.enum(["shot", "video", "firstFrame", "lastFrame"]), shotId: z.uuid().nullable(),
  text: z.string().max(100000), inputSnapshot: z.string().max(10000000), version: z.number().int().positive(), source: z.literal("manual") }).strict()
  .refine(value => value.kind === "shot" ? value.shotId !== null : value.shotId === null);
function seedPromptHistory(database: DatabaseSync): void {
  const recordedAt = new Date().toISOString();
  for (const row of database.prepare("SELECT id,workspace_json FROM tasks").iterate()) {
    let prompts: z.infer<typeof baselinePrompt>[];
    try {
      const workspace = JSON.parse(String(row.workspace_json));
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new Error("Invalid workspace");
      prompts = z.array(baselinePrompt).max(203).parse(workspace.prompts ?? []);
      if (new Set(prompts.map(prompt => `${prompt.kind}:${prompt.shotId ?? ""}`)).size !== prompts.length
        || prompts.some(prompt => prompt.kind === "shot" && !Array.isArray(workspace.shots))) throw new Error("Invalid prompt ownership");
      if (prompts.some(prompt => prompt.kind === "shot" && !workspace.shots.some((shot: { id?: string }) => shot?.id === prompt.shotId))) throw new Error("Missing shot");
    } catch { throw new Error(`提示词历史迁移失败：任务 ${String(row.id)} 的制作内容无法解析，历史版本迁移已回滚，请检查工作区（此前成功的版本升级保留）。`); }
    for (const prompt of prompts) database.prepare("INSERT INTO prompt_history VALUES (?,?,?,?,?,?,?,'baseline')")
      .run(String(row.id), prompt.kind, prompt.shotId ?? "", prompt.version, prompt.text, prompt.inputSnapshot, recordedAt);
  }
}

function seedScriptHistory(database: DatabaseSync): void {
  const recordedAt = new Date().toISOString();
  for (const row of database.prepare("SELECT id,workspace_json FROM tasks").iterate()) {
    let text: string;
    try {
      const workspace = JSON.parse(String(row.workspace_json));
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new Error("Invalid workspace");
      text = z.string().max(100000).parse(workspace.script);
    } catch { throw new Error(`剧本历史迁移失败：任务 ${String(row.id)} 的剧本无法解析，剧本历史迁移已回滚（此前成功的版本升级保留）。`); }
    // Empty legacy scripts are real current baselines too; their earlier edits are unknown.
    database.prepare("INSERT INTO script_history VALUES (?,1,?,?,'baseline')").run(String(row.id), text, recordedAt);
  }
}

/** Trusted version-specific DDL only; never executes schema supplied by a backup. */
export function trustedDatabaseSchema(version: 3 | 4 | 5 | 6 | 7): string {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter(item => item.version <= version)) database.exec(migration.sql);
    return JSON.stringify(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all());
  } finally { database.close(); }
}

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
        if (migration.version === 5) seedPromptHistory(this.connection);
        if (migration.version === 6) seedScriptHistory(this.connection);
        this.connection.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }
}
