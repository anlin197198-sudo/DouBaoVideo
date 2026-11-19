import type { Account, ReferenceImage, BackupResult, BackupValidationResult } from "../../shared/models";
import { CommandRouter } from "./command-router";
import type { ApplicationDatabase } from "../infrastructure/database";
import { WorkspaceRepository } from "../infrastructure/workspace-repository";
import type { Logger } from "../core/logger";
import { DoubaoProvider } from "../providers/doubao-provider";

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
  backups?: { create(): Promise<BackupResult | null> };
  backupValidation?: { verify(): Promise<BackupValidationResult | null> };
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
  router.register("workspace.read", () => repository.snapshot());
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
