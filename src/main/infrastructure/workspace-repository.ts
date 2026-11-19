import { randomUUID, createHash } from "node:crypto";
import { planChangePreview, removalProblem } from "../../shared/plan-changes";
import { inheritsStyleNotes } from "../../shared/prompts";
import type {
  Account,
  Plan,
  TaskWorkspace,
  VideoTask,
  WorkspaceSnapshot,
  PromptHistorySummary,
} from "../../shared/models";
import type { CommandInputs } from "../../shared/bridge";
import { ApplicationError } from "../core/errors";
import type { ApplicationDatabase } from "./database";
import { confirmationBlocker, confirmationInput, currentFrame } from "../../shared/frames";

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
    revision: Number(row.revision ?? 0),
    id: String(row.id),
    title: String(row.title),
    style: row.style as Plan["style"],
    styleNotes: String(row.style_notes ?? ""),
    startDate: String(row.start_date),
    dailyCount: Number(row.daily_count),
    executionTime: String(row.execution_time),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
  };
}

function taskFromRow(row: Row): VideoTask {
  // Version 1 workspaces only contain the script. Restore them without rewriting
  // existing content or changing the task's optimistic concurrency revision.
  const workspace = JSON.parse(String(row.workspace_json)) as TaskWorkspace;
  return {
    scheduleActive: row.schedule_active !== 0,
    executionTime: row.execution_time ? String(row.execution_time) : undefined,
    id: String(row.id),
    planId: String(row.plan_id),
    title: String(row.title),
    businessDate: String(row.business_date),
    sequence: Number(row.sequence),
    status: row.status as VideoTask["status"],
    revision: Number(row.revision),
    workspace: { ...workspace, shots: workspace.shots ?? [], assets: workspace.assets ?? [], assetLinks: workspace.assetLinks ?? [] },
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
      referenceImages: db.prepare("SELECT * FROM reference_images ORDER BY created_at, id").all()
        .map(row => ({
          id: String(row.id), taskId: String(row.task_id), originalName: String(row.original_name),
          width: Number(row.width), height: Number(row.height), createdAt: String(row.created_at),
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
    db.prepare("INSERT INTO plans (id,title,style,start_date,daily_count,execution_time,enabled,created_at,style_notes) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)").run(
      id,
      input.title,
      input.style,
      input.startDate,
      input.dailyCount,
      input.executionTime,
      now,
      input.styleNotes ?? "",
    );
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, plan_id, title, business_date, sequence, workspace_json, updated_at, execution_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
          shots: [],
          assets: [],
          assetLinks: [],
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
          input.executionTime,
        );
        tasks.push({
          id: taskId,
          planId: id,
          title,
          businessDate,
          sequence,
          status: "draft",
          revision: 0,
          scheduleActive: true,
          executionTime: input.executionTime,
          workspace,
          updatedAt: now,
        });
      }
    }
    return { plan: { id, ...input, styleNotes: input.styleNotes ?? "", revision: 0, enabled: true, createdAt: now }, tasks };
  }

  setPlanEnabled(id: string, enabled: boolean): Plan {
    const row = this.database.connection
      .prepare("UPDATE plans SET enabled = ?, revision = revision + 1 WHERE id = ? RETURNING *")
      .get(Number(enabled), id);
    if (!row)
      throw new ApplicationError(
        "NOT_FOUND",
        "这份周计划已不存在，请刷新列表。",
      );
    return planFromRow(row);
  }

  previewPlanEdit(input: CommandInputs["plans.previewEdit"]) {
    const db = this.database.connection;
    const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(input.id);
    if (!row) throw new ApplicationError("NOT_FOUND", "计划不存在，请刷新列表。");
    const plan = planFromRow(row);
    const changes = { ...input.changes, styleNotes: input.changes.styleNotes ?? plan.styleNotes ?? "" };
    const tasks = db.prepare("SELECT * FROM tasks WHERE plan_id = ? ORDER BY business_date, sequence, id").all(input.id).map(taskFromRow);
    const executions = db.prepare("SELECT e.* FROM executions e JOIN tasks t ON e.task_id = t.id WHERE t.plan_id = ? ORDER BY e.id").all(input.id);
    const films = db.prepare("SELECT f.* FROM films f JOIN tasks t ON f.task_id = t.id WHERE t.plan_id = ? ORDER BY f.id").all(input.id);
    const lockedIds = new Set([...executions, ...films].map(item => String(item.task_id)));
    // Future statuses must be explicitly reviewed before they become reschedulable.
    tasks.filter(task => !["draft", "review_required", "scheduled"].includes(task.status)).forEach(task => lockedIds.add(task.id));
    const preview = planChangePreview(plan, tasks, lockedIds, changes);
    if (plan.style !== changes.style && lockedIds.size)
      preview.blockers.push("本计划已有执行记录，暂不允许修改整体风格，以保留历史输入。请新建不同风格的计划。");
    if ((plan.styleNotes ?? "") !== changes.styleNotes && tasks.some(task => lockedIds.has(task.id) && inheritsStyleNotes(task.workspace)))
      preview.blockers.push("已有执行历史的任务继承计划说明，不能修改该说明；请新建计划，以保留历史输入。");
    const token = createHash("sha256").update(JSON.stringify({ plan, tasks, executions, films, changes })).digest("hex");
    return { ...preview, token };
  }

  applyPlanEdit(input: CommandInputs["plans.applyEdit"]) {
    // Called within the command router's immediate transaction, including the receipt.
    const preview = this.previewPlanEdit(input);
    if (preview.token !== input.previewToken) throw new ApplicationError("CONFLICT", "计划或任务已变化，请重新预览并选择移出任务。未应用任何修改。");
    const problem = removalProblem(preview, input.removeTaskIds);
    if (problem) throw new ApplicationError("INVALID_INPUT", problem);
    const db = this.database.connection;
    const now = new Date().toISOString();
    const changes = preview.changes;
    const remove = new Set(input.removeTaskIds);
    const editable = [...preview.outside, ...preview.days.flatMap(day => day.editable)];
    // Archived drafts remain editable and continue inheriting this plan's style.
    const archived = db.prepare("SELECT * FROM tasks WHERE plan_id = ? AND schedule_active = 0").all(input.id).map(taskFromRow);
    const affectedStyle = new Set(preview.styleAffected);
    for (const task of [...editable, ...archived.filter(task => affectedStyle.has(task.id))]) {
      const workspace = task.workspace;
      if (affectedStyle.has(task.id) && workspace.frames?.confirmation)
        workspace.frames.confirmation = { ...workspace.frames.confirmation, invalidated: true };
      const active = task.scheduleActive !== false && !remove.has(task.id);
      db.prepare("UPDATE tasks SET schedule_active = ?, execution_time = ?, workspace_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(Number(active), active ? changes.executionTime : task.executionTime ?? preview.plan.executionTime, JSON.stringify(workspace), now, task.id);
    }
    for (const day of preview.days) {
      const maximum = db.prepare("SELECT MAX(sequence) AS maximum FROM tasks WHERE plan_id = ? AND business_date = ?").get(input.id, day.date);
      // Never reuse archived task identities or slots; their content remains intact.
      const next = Number(maximum?.maximum ?? 0) + 1;
      for (let index = 0; index < day.add; index++) {
        const workspace: TaskWorkspace = { script: "", viewport: { x: 0, y: 0, zoom: 1 }, scriptPosition: { x: 80, y: 100 }, shots: [], assets: [], assetLinks: [] };
        db.prepare("INSERT INTO tasks (id,plan_id,title,business_date,sequence,workspace_json,updated_at,execution_time) VALUES (?,?,?,?,?,?,?,?)")
          .run(randomUUID(), input.id, `${changes.title} · ${day.date} · ${next + index}`, day.date, next + index, JSON.stringify(workspace), now, changes.executionTime);
      }
    }
    const row = db.prepare("UPDATE plans SET title=?, style=?, start_date=?, daily_count=?, execution_time=?, style_notes=?, revision=revision+1 WHERE id=? RETURNING *")
      .get(changes.title, changes.style, changes.startDate, changes.dailyCount, changes.executionTime, changes.styleNotes ?? "", input.id)!;
    return { plan: planFromRow(row), tasks: db.prepare("SELECT * FROM tasks WHERE plan_id = ? ORDER BY business_date,sequence,id").all(input.id).map(taskFromRow) };
  }

  saveWorkspace(input: CommandInputs["tasks.saveWorkspace"]): VideoTask {
    const previous = this.getTask(input.id);
    if (previous.revision !== input.expectedRevision)
      throw new ApplicationError("CONFLICT", "任务已更新，请重新读取后再保存。当前编辑内容仍在编辑区。");
    const previousAssets = new Map(previous.workspace.assets.map(asset => [asset.id, asset]));
    const changedAssetIds = new Set<string>();
    const workspace: TaskWorkspace = { ...input.workspace, assets: input.workspace.assets.map(asset => {
      if (asset.referenceImageId) {
        const image = this.database.connection.prepare("SELECT id FROM reference_images WHERE id = ? AND task_id = ?")
          .get(asset.referenceImageId, input.id);
        if (!image) throw new ApplicationError("INVALID_INPUT", "参考图不属于当前任务，请重新选择或导入。");
      }
      const old = previousAssets.get(asset.id);
      const changed = old && ["name", "type", "description", "referenceImageId"].some(key =>
        old[key as keyof typeof old] !== asset[key as keyof typeof asset]);
      if (changed) changedAssetIds.add(asset.id);
      return { ...asset, version: old ? old.version + (changed ? 1 : 0) : 1 };
    }) };
    const linkSet = (value: TaskWorkspace, shotId: string) => value.assetLinks
      .filter(link => link.shotId === shotId).map(link => link.assetId).sort().join(",");
    workspace.shots = workspace.shots.map(shot => {
      const affected = linkSet(previous.workspace, shot.id) !== linkSet(workspace, shot.id)
        || workspace.assetLinks.some(link => link.shotId === shot.id && changedAssetIds.has(link.assetId));
      return affected ? { ...shot, assetsNeedReview: true } : shot;
    });
    if (workspace.prompts) workspace.prompts = workspace.prompts.map(prompt => {
      const old = previous.workspace.prompts?.find(item => item.kind === prompt.kind && item.shotId === prompt.shotId);
      const changed = old && (old.text !== prompt.text || old.inputSnapshot !== prompt.inputSnapshot);
      const historical = this.database.connection.prepare("SELECT MAX(version) AS maximum FROM prompt_history WHERE task_id=? AND kind=? AND shot_key=?")
        .get(input.id, prompt.kind, prompt.shotId ?? "");
      return { ...prompt, version: old ? old.version + (changed ? 1 : 0) : Number(historical?.maximum ?? 0) + 1 };
    });
    if (workspace.frames) {
      for (const candidate of workspace.frames.candidates) {
        if (!this.database.connection.prepare("SELECT id FROM reference_images WHERE id = ? AND task_id = ?").get(candidate.imageId, input.id))
          throw new ApplicationError("INVALID_INPUT", "候选图片不属于当前任务，请重新导入。");
        const old = previous.workspace.frames?.candidates.find(item => item.id === candidate.id);
        if (old && JSON.stringify(old) !== JSON.stringify(candidate))
          throw new ApplicationError("INVALID_INPUT", "已有候选来源不可修改，请添加新候选。");
      }
      const oldConfirmation = previous.workspace.frames?.confirmation ?? null;
      const plan = this.database.connection.prepare("SELECT style,style_notes FROM plans WHERE id = ?").get(previous.planId)!;
      // Only the explicit confirm command can create confirmation. Keep invalidation sticky.
      workspace.frames = { ...workspace.frames, confirmation: oldConfirmation ? { ...oldConfirmation,
        invalidated: oldConfirmation.invalidated || workspace.frames.confirmation?.invalidated === true
          || oldConfirmation.inputSnapshot !== confirmationInput(workspace, { style: plan.style as Plan["style"], styleNotes: String(plan.style_notes) }),
      } : null };
    }
    const row = this.database.connection
      .prepare(
        `
      UPDATE tasks SET workspace_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? RETURNING *
    `,
      )
      .get(
        JSON.stringify(workspace),
        new Date().toISOString(),
        input.id,
        input.expectedRevision,
      );
    if (row) {
      const recordedAt = new Date().toISOString();
      for (const prompt of workspace.prompts ?? []) {
        const old = previous.workspace.prompts?.find(item => item.kind === prompt.kind && item.shotId === prompt.shotId);
        if (!old || old.version !== prompt.version) this.database.connection.prepare("INSERT INTO prompt_history VALUES (?,?,?,?,?,?,?,'saved')")
          .run(input.id, prompt.kind, prompt.shotId ?? "", prompt.version, prompt.text, prompt.inputSnapshot, recordedAt);
      }
      return taskFromRow(row);
    }
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

  getTask(id: string): VideoTask {
    const row = this.database.connection.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw new ApplicationError("NOT_FOUND", "这条任务已不存在，请刷新列表。");
    return taskFromRow(row);
  }

  listPromptHistory(input: CommandInputs["prompts.historyList"]) {
    this.getTask(input.taskId);
    const limit = input.limit ?? 20;
    const rows = this.database.connection.prepare(`SELECT version,recorded_at,record_type,length(text) AS text_length,length(input_snapshot) AS input_length
      FROM prompt_history WHERE task_id=? AND kind=? AND shot_key=? AND version < ? ORDER BY version DESC LIMIT ?`)
      .all(input.taskId, input.kind, input.shotId ?? "", input.beforeVersion ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const items = rows.slice(0, limit).map(row => this.historySummary(row));
    return { items, nextBeforeVersion: rows.length > limit ? items.at(-1)!.version : null };
  }

  private historySummary(row: Row): PromptHistorySummary {
    return { version: Number(row.version), recordedAt: String(row.recorded_at), recordType: row.record_type as "baseline" | "saved",
      textLength: Number(row.text_length), inputLength: Number(row.input_length) };
  }

  getPromptHistory(input: CommandInputs["prompts.historyDetail"]) {
    this.getTask(input.taskId);
    const row = this.database.connection.prepare(`SELECT *,length(text) AS text_length,length(input_snapshot) AS input_length
      FROM prompt_history WHERE task_id=? AND kind=? AND shot_key=? AND version=?`)
      .get(input.taskId, input.kind, input.shotId ?? "", input.version);
    if (!row) throw new ApplicationError("NOT_FOUND", "这个任务与提示词位置没有该历史版本。");
    return { ...this.historySummary(row), text: String(row.text), inputSnapshot: String(row.input_snapshot) };
  }

  confirmFrames(input: CommandInputs["tasks.confirmFrames"], isAvailable: (imageId: string) => boolean): VideoTask {
    const task = this.getTask(input.id);
    if (task.revision !== input.expectedRevision) throw new ApplicationError("CONFLICT", "任务已更新，请重新读取并检查图片后确认。");
    const plan = this.database.connection.prepare("SELECT style,style_notes FROM plans WHERE id = ?").get(task.planId)!;
    const style = { style: plan.style as Plan["style"], styleNotes: String(plan.style_notes) };
    const blocker = confirmationBlocker(task.workspace, style);
    if (blocker) throw new ApplicationError("INVALID_INPUT", blocker);
    for (const slot of ["first", "last"] as const) {
      const candidate = currentFrame(task.workspace, slot)!;
      if (!this.database.connection.prepare("SELECT id FROM reference_images WHERE id = ? AND task_id = ?").get(candidate.imageId, task.id)
        || !isAvailable(candidate.imageId)) throw new ApplicationError("STORAGE_ERROR", "图片文件不可用，请重新导入后再确认。");
    }
    task.workspace.frames!.confirmation = { inputSnapshot: confirmationInput(task.workspace, style),
      confirmedAt: new Date().toISOString(), invalidated: false };
    const row = this.database.connection.prepare("UPDATE tasks SET workspace_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? RETURNING *")
      .get(JSON.stringify(task.workspace), new Date().toISOString(), task.id, task.revision);
    if (!row) throw new ApplicationError("CONFLICT", "任务已变化，请重新确认。");
    return taskFromRow(row);
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
