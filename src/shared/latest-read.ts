/** A read result belongs only to the current view/request, never a later selection. */
export class LatestRead {
  private generation = 0;
  begin(): number { return ++this.generation; }
  current(token: number): boolean { return token === this.generation; }
  cancel(): void { this.generation++; }
}

/** Independent history channels: an autosave list refresh must not cancel a selected version. */
export class HistoryReads {
  readonly list = new LatestRead();
  readonly detail = new LatestRead();
  cancel(): void { this.list.cancel(); this.detail.cancel(); }
}
