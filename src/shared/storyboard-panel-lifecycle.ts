/** Ownership of a result is bound to the mounted panel and its committed editing context. */
export class StoryboardPanelLifecycle {
  private current: { taskId: string; revision: number; ready: boolean } | null = null;
  private epoch = 0;

  update(taskId: string, revision: number, ready: boolean): void {
    if (this.current?.taskId === taskId && this.current.revision === revision && this.current.ready === ready) return;
    this.current = { taskId, revision, ready };
    this.cancel();
  }

  cancel(): void { this.epoch++; }
  close(): void { this.current = null; this.cancel(); }

  capture(taskId: string, revision: number): (() => boolean) | null {
    if (this.current?.taskId !== taskId || this.current.revision !== revision || !this.current.ready) return null;
    const epoch = this.epoch;
    return () => this.current !== null && this.epoch === epoch;
  }
}
