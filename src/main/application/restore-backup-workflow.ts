import type { BackupValidationResult, IsolatedRestoreResult } from "../../shared/models";
import { ApplicationError } from "../core/errors";

export type RestorePreview = BackupValidationResult & { manifestSha256: string };

/** Native UI is injected: no renderer-provided paths and no restore output before confirmation (validation uses a disposable temporary database). */
export class RestoreBackupWorkflow {
  private running = false;
  constructor(private readonly dependencies: {
    chooseSource(): Promise<string | null>;
    validate(source: string): Promise<RestorePreview>;
    chooseDestination(): Promise<string | null>;
    confirm(input: { source: string; destinationParent: string; validation: BackupValidationResult }): Promise<boolean>;
    restore(source: string, destinationParent: string, expectedManifestSha256: string): Promise<IsolatedRestoreResult>;
  }) {}
  async run(): Promise<IsolatedRestoreResult | null> {
    if (this.running) throw new ApplicationError("CONFLICT", "隔离恢复或目录选择正在进行，请先完成当前操作。");
    this.running = true;
    try {
      const source = await this.dependencies.chooseSource(); if (!source) return null;
      const validation = await this.dependencies.validate(source);
      const destinationParent = await this.dependencies.chooseDestination(); if (!destinationParent) return null;
      if (!await this.dependencies.confirm({ source, destinationParent, validation })) return null;
      return await this.dependencies.restore(source, destinationParent, validation.manifestSha256);
    } finally { this.running = false; }
  }
}
