import { randomUUID } from "node:crypto";
import type {
  Account,
  Plan,
  TaskWorkspace,
  VideoTask,
  WorkspaceSnapshot,
} from "../../shared/models";
import type { CommandInputs } from "../../shared/bridge";
import { ApplicationError } from "../core/errors";
import type { ApplicationDatabase } from "./database";

type Row = Record<string, unknown>;

function accountFromRow(row: Row): Account {
  return {
    id: String(row.id),
    nickname: String(row.nickname),
    tier: row.tier as Account["tier"],
    tierSource: row.tier_source as Account["tierSource"],
    enabled: Boolean(row.enabled),
    loginState: row.login_state as Account["loginState"],
    imageCapability: row.image_capability as Account["imageCapability"],
    videoCapability: row.video_capability as Account["videoCapability"],
    createdAt: String(row.created_at),
  };
}

function planFromRow(row: Row): Plan {
  return {
    id: String(row.id),
    title: String(row.title),
    style: row.style as Plan["style"],
    startDate: String(row.start_date),
    dailyCount: Number(row.daily_count),
    executionTime: String(row.execution_time),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
  };
}

function taskFromRow(row: Row): VideoTask {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    title: String(row.title),
    businessDate: String(row.business_date),
    sequence: Number(row.sequence),
    status: row.status as VideoTask["status"],
    revision: Number(row.revision),
    workspace: JSON.parse(String(row.workspace_json)) as TaskWorkspace,
    updatedAt: String(row.updated_at),
  };
}

export class WorkspaceRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  snapshot(): WorkspaceSnapshot {
    const db = this.database.connection;
    return {
      plans: db
        .prepare("SELECT * FROM plans ORDER BY created_at DESC, id")
        .all()
        .map(planFromRow),
      tasks: db
        .prepare("SELECT * FROM tasks ORDER BY business_date, sequence, id")
        .all()
        .map(taskFromRow),
      accounts: db
        .prepare("SELECT * FROM accounts ORDER BY created_at, id")
        .all()
        .map(accountFromRow),
      executions: db
        .prepare("SELECT * FROM executions ORDER BY created_at DESC")
        .all()
        .map((row) => ({
          id: String(row.id),
          taskId: String(row.task_id),
          status: String(row.status),
          accountId: row.account_id === null ? null : String(row.account_id),
          createdAt: String(row.created_at),
        })),
      films: db
        .prepare("SELECT * FROM films ORDER BY created_at DESC")
        .all()
        .map((row) => ({
          id: String(row.id),
          taskId: String(row.task_id),
          filePath: String(row.file_path),
          version: Number(row.version),
        })),
    };
  }

  createPlan(input: CommandInputs["plans.create"]): {
    plan: Plan;
    tasks: VideoTask[];
  } {
    const id = randomUUID();
    const now = new Date().toISOString();
    const db = this.database.connection;
    db.prepare("INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, 1, ?)").run(
      id,
      input.title,
      input.style,
      input.startDate,
      input.dailyCount,
      input.executionTime,
      now,
    );
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, plan_id, title, business_date, sequence, workspace_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const tasks: VideoTask[] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(input.startDate + "T12:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + day);
      const businessDate = date.toISOString().slice(0, 10);
      for (let sequence = 1; sequence <= input.dailyCount; sequence++) {
        const workspace: TaskWorkspace = {
          script: "",
          viewport: { x: 0, y: 0, zoom: 1 },
          scriptPosition: { x: 80, y: 100 },
        };
        const taskId = randomUUID();
        const title = `${input.title} · ${day + 1}-${sequence}`;
        insertTask.run(
          taskId,
          id,
          title,
          businessDate,
          sequence,
          JSON.stringify(workspace),
          now,
        );
        tasks.push({
          id: taskId,
          planId: id,
          title,
          businessDate,
          sequence,
          status: "draft",
          revision: 0,
          workspace,
          updatedAt: now,
        });
      }
    }
    return { plan: { id, ...input, enabled: true, createdAt: now }, tasks };
  }

  setPlanEnabled(id: string, enabled: boolean): Plan {
    const row = this.database.connection
      .prepare("UPDATE plans SET enabled = ? WHERE id = ? RETURNING *")
      .get(Number(enabled), id);
    if (!row)
      throw new ApplicationError(
        "NOT_FOUND",
        "这份周计划已不存在，请刷新列表。",
      );
    return planFromRow(row);
  }

  saveWorkspace(input: CommandInputs["tasks.saveWorkspace"]): VideoTask {
    const row = this.database.connection
      .prepare(
        `
      UPDATE tasks SET workspace_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? RETURNING *
    `,
      )
      .get(
        JSON.stringify(input.workspace),
        new Date().toISOString(),
        input.id,
        input.expectedRevision,
      );
    if (row) return taskFromRow(row);
    const existing = this.database.connection
      .prepare("SELECT id FROM tasks WHERE id = ?")
      .get(input.id);
    if (!existing)
      throw new ApplicationError("NOT_FOUND", "这条任务已不存在，请刷新列表。");
    throw new ApplicationError(
      "CONFLICT",
      "任务已更新，请重新读取后再保存。当前编辑内容仍在编辑区。",
    );
  }

  createAccount(nickname: string): Account {
    const row = this.database.connection
      .prepare(
        "INSERT INTO accounts (id, nickname, created_at) VALUES (?, ?, ?) RETURNING *",
      )
      .get(randomUUID(), nickname, new Date().toISOString());
    return accountFromRow(row!);
  }

  getAccount(id: string): Account {
    const row = this.database.connection
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(id);
    if (!row)
      throw new ApplicationError("NOT_FOUND", "这个账号已不存在，请刷新列表。");
    return accountFromRow(row);
  }

  updateAccount(input: CommandInputs["accounts.update"]): Account {
    const row = this.database.connection
      .prepare(
        `
      UPDATE accounts SET nickname = ?, tier = ?, tier_source = ?, enabled = ? WHERE id = ? RETURNING *
    `,
      )
      .get(
        input.nickname,
        input.tier,
        input.tier === "unknown" ? "unknown" : "manual",
        Number(input.enabled),
        input.id,
      );
    if (!row)
      throw new ApplicationError("NOT_FOUND", "这个账号已不存在，请刷新列表。");
    return accountFromRow(row);
  }
}
