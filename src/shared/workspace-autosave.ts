import type { TaskWorkspace, VideoTask } from "./models";

export interface SaveState { dirty: boolean; saving: boolean; error: string | null; requestId: string | null; conflict: boolean }

/** One writer owns the server revision. New edits never get replaced by older replies. */
export class WorkspaceAutosave {
  private value: TaskWorkspace;
  private revision: number;
  private generation = 0;
  private savedGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<boolean> | null = null;
  private paused = false;
  private disposed = false;
  private failure: string | null = null;
  private failureRequestId: string | null = null;
  private conflict = false;
  private readonly taskId: string;
  constructor(task: VideoTask, private readonly write: (workspace: TaskWorkspace, revision: number) => Promise<VideoTask>,
    private readonly changed: (state: SaveState, normalized?: TaskWorkspace) => void, private readonly delay = 800) {
    this.value = task.workspace; this.revision = task.revision; this.taskId = task.id;
  }
  get state(): SaveState { return { dirty: this.generation !== this.savedGeneration, saving: this.running !== null, error: this.failure, requestId: this.failureRequestId, conflict: this.conflict }; }
  get workspace() { return this.value; }
  get savedRevision() { return this.revision; }
  private emit(normalized?: TaskWorkspace) { if (!this.disposed) this.changed(this.state, normalized); }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule() {
    this.clearTimer();
    if (!this.disposed && !this.paused && !this.failure && !this.running && this.state.dirty)
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delay);
  }
  update(workspace: TaskWorkspace) {
    if (this.disposed || workspace === this.value) return;
    this.value = workspace; this.generation++; this.emit(); this.schedule();
  }
  pause(paused: boolean) { this.paused = paused; if (paused) this.clearTimer(); else this.schedule(); }
  accept(task: VideoTask) {
    if (this.state.dirty || this.running) throw new Error("仍有未保存内容，不能覆盖草稿。");
    this.value = task.workspace; this.revision = task.revision; this.emit(this.value);
  }
  /** Only after the user reviews the remote version and explicitly chooses. */
  resolveConflict(latest: VideoTask, choice: "overwrite" | "discard"): Promise<boolean> {
    if (!this.conflict || this.running || this.disposed || this.paused) return Promise.resolve(false);
    if (latest.id !== this.taskId || latest.revision < this.revision) throw new Error("读取的任务版本无效，请重新读取。");
    this.clearTimer(); this.revision = latest.revision; this.failure = null; this.failureRequestId = null; this.conflict = false;
    if (choice === "discard") {
      this.value = latest.workspace; this.savedGeneration = this.generation; this.emit(this.value);
      return Promise.resolve(true);
    }
    return this.flush(true);
  }
  flush(retry = false): Promise<boolean> {
    this.clearTimer();
    if (this.running) return this.running;
    if (this.disposed || this.paused) return Promise.resolve(false);
    if (this.conflict) return Promise.resolve(false);
    if (retry) { this.failure = null; this.failureRequestId = null; }
    if (this.failure) return Promise.resolve(false);
    if (!this.state.dirty) return Promise.resolve(true);
    // Defer draining one microtask so even a synchronously throwing writer is locked.
    this.running = Promise.resolve().then(async () => {
      while (this.state.dirty && !this.paused && !this.disposed) {
        const generation = this.generation, input = this.value;
        try {
          const task = await this.write(input, this.revision);
          this.revision = task.revision; this.savedGeneration = generation;
          if (generation === this.generation) { this.value = task.workspace; this.emit(this.value); }
          else this.emit();
        } catch (cause) {
          this.failure = cause instanceof Error ? cause.message : "保存失败，请重试。";
          const requestId = cause instanceof Error && "requestId" in cause ? cause.requestId : null;
          this.failureRequestId = typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? requestId : null;
          this.conflict = typeof cause === "object" && cause !== null && "code" in cause && cause.code === "CONFLICT";
          return false;
        }
      }
      return !this.state.dirty;
    }).finally(() => { this.running = null; this.emit(); this.schedule(); });
    this.emit();
    return this.running;
  }
  dispose() { this.disposed = true; this.clearTimer(); }
}
