import type { Account } from "../../shared/models";
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

  return { router, repository, provider };
}
