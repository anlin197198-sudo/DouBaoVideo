export interface DesktopWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  hide(): void;
}
export interface DesktopTray { isDestroyed(): boolean; destroy(): void }
export interface DesktopActions { open(): void; queue(): void; exit(): void }

/** No close interception: Electron/renderer beforeunload remains authoritative. */
export class DesktopLifecycle {
  private tray: DesktopTray | null = null;
  private pendingQueue = false;
  private stopped = false;
  private opening = false;
  constructor(private readonly deps: {
    window(): DesktopWindow | null;
    createWindow(): Promise<void>;
    openFailed(): void;
    createTray(actions: DesktopActions): DesktopTray;
    signalQueue(): void;
    quit(): void;
    cleanup(): void;
  }) {}
  start(): boolean {
    if (this.stopped) return false;
    if (this.tray && !this.tray.isDestroyed()) return true;
    try {
      const tray = this.deps.createTray({ open: () => this.open(), queue: () => this.requestQueue(), exit: () => this.exit() });
      if (tray.isDestroyed()) return false;
      this.tray = tray;
      return true;
    } catch { this.tray = null; return false; }
  }
  open(): void {
    if (this.stopped || this.opening) return;
    const window = this.deps.window();
    if (!window || window.isDestroyed()) {
      if (this.opening) return;
      this.opening = true;
      void Promise.resolve().then(() => { if (!this.stopped) return this.deps.createWindow(); }).then(() => {
        const created = this.deps.window();
        if (!this.stopped && created && !created.isDestroyed()) {
          created.show(); created.focus();
        }
      }).catch(() => { if (!this.stopped) this.deps.openFailed(); }).finally(() => { this.opening = false; });
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
  minimize(): boolean {
    const window = this.deps.window();
    if (this.stopped || !this.tray || this.tray.isDestroyed() || !window || window.isDestroyed()) return false;
    window.hide();
    return true;
  }
  requestQueue(): void {
    if (this.stopped) return;
    this.pendingQueue = true;
    this.open();
    this.deps.signalQueue();
  }
  consumeQueue(trusted: boolean, args: unknown[]): boolean {
    if (!trusted || args.length !== 0 || this.stopped) return false;
    const pending = this.pendingQueue;
    this.pendingQueue = false;
    return pending;
  }
  exit(): void {
    if (this.stopped) return;
    // Reveal save/veto feedback, but never create a missing window just to quit.
    const window = this.deps.window();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
    this.deps.quit();
  }
  /** Called only after all beforeunload/close vetoes have passed. */
  willQuit(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingQueue = false;
    try { if (this.tray && !this.tray.isDestroyed()) this.tray.destroy(); }
    finally { this.tray = null; this.deps.cleanup(); }
  }
}
