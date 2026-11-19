import {ScriptReuseWorkflow} from "./script-reuse-workflow";
import type { Account, ReferenceImage, BackupResult, BackupValidationResult, IsolatedRestoreResult } from "../../shared/models";
import { CommandRouter } from "./command-router";
import type { ApplicationDatabase } from "../infrastructure/database";
import { WorkspaceRepository } from "../infrastructure/workspace-repository";
import type { Logger } from "../core/logger";
import { DoubaoProvider } from "../providers/doubao-provider";

import { createStoryboardPlannerWorkflow, type StoryboardPlannerPort, type StoryboardConfirmation } from "./storyboard-planner-workflow";

export interface SessionGateway {
  open(account: Account): Promise<void>;
}

export function createApplicationServices(options: {
  database: ApplicationDatabase;
  logger: Logger;
  sessions: SessionGateway;
  version: string;
  dataDirectory: string;
  references?: { importForTask(taskId: string): Promise<ReferenceImage | null>; isAvailable?(imageId: string): boolean };
  storyboardPlanner?: StoryboardPlannerPort;
  confirmStoryboard?: (input: StoryboardConfirmation) => Promise<boolean>;
  backups?: { create(): Promise<BackupResult | null> };
  backupValidation?: { verify(): Promise<BackupValidationResult | null> };
  backupRestore?: { run(): Promise<IsolatedRestoreResult | null> };
}) {
  const { database, logger, sessions } = options;
  const repository = new WorkspaceRepository(database);
  const provider = new DoubaoProvider();
  const router = new CommandRouter(database, logger);

  router.register("app.info", () => ({
    version: options.version,
    databaseVersion: database.version,
    dataDirectory: options.dataDirectory,
    provider: provider.readiness(),
  }));
  const storyboard = createStoryboardPlannerWorkflow({
    getTask: id => repository.getTask(id), planner: options.storyboardPlanner, confirm: options.confirmStoryboard,
  });
  router.register("storyboard.readiness", storyboard.readiness);
  router.register("storyboard.generatePreview", storyboard.generate);
  router.register("storyboard.adoptDraft", storyboard.adopt);
  router.register("workspace.read", () => repository.snapshot());
  const scriptReuse = new ScriptReuseWorkflow(database);
  router.register("scripts.previewReuse", input => scriptReuse.preview(input));
  router.register("scripts.applyReuse", input => scriptReuse.apply(input));
  router.register("scripts.historyList", input => repository.listScriptHistory(input));
  router.register("scripts.historyDetail", input => repository.getScriptHistory(input));
  router.register("prompts.historyList", input => repository.listPromptHistory(input));
  router.register("prompts.historyDetail", input => repository.getPromptHistory(input));
  router.register("workspace.backup", async () => {
    if (!options.backups) throw new Error("Backup service is unavailable");
    return options.backups.create();
  });
  router.register("workspace.verifyBackup", async () => {
    if (!options.backupValidation) throw new Error("Backup validation service is unavailable");
    return options.backupValidation.verify();
  });
  router.register("workspace.restoreBackup", async () => {
    if (!options.backupRestore) throw new Error("Isolated restore workflow is unavailable");
    return options.backupRestore.run();
  });
  router.register("plans.previewEdit", input => repository.previewPlanEdit(input));
  router.register("plans.applyEdit", input => repository.applyPlanEdit(input), { transactional: true });
  router.register("plans.create", (input) => repository.createPlan(input), {
    transactional: true,
  });
  router.register(
    "plans.setEnabled",
    (input) => repository.setPlanEnabled(input.id, input.enabled),
    { transactional: true },
  );
  router.register(
    "tasks.saveWorkspace",
    (input) => repository.saveWorkspace(input),
    { transactional: true },
  );
  router.register(
    "accounts.create",
    (input) => repository.createAccount(input.nickname),
    { transactional: true },
  );
  router.register(
    "accounts.update",
    (input) => repository.updateAccount(input),
    { transactional: true },
  );
  router.register("accounts.openLogin", async (input) => {
    repository.assertAccountAvailable(input.id);
    await sessions.open(repository.getAccount(input.id));
    return { opened: true };
  });
  router.register("assets.importReference", async ({ taskId }) => {
    repository.getTask(taskId);
    if (!options.references) throw new Error("Reference image importer is not configured");
    return options.references.importForTask(taskId);
  });
  router.register("tasks.confirmFrames", input => repository.confirmFrames(input,
    imageId => options.references?.isAvailable?.(imageId) ?? false), { transactional: true });

  return { router, repository, provider };
}
