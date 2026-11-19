/** Separate a durable mutation from refreshing its view. A read failure is not a failed write. */
export class AppliedMutation {
  applied = false;
  async commit(write: () => Promise<unknown>): Promise<void> {
    if (this.applied) return;
    await write();
    this.applied = true;
  }
  async refresh(read: () => Promise<void>): Promise<void> {
    if (!this.applied) throw new Error("修改尚未保存，不能作为已保存结果刷新。");
    await read();
  }
}
