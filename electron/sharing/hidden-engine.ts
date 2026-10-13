import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
/** Lazy preload host. Only live resources or commands keep its renderer alive. */
export class HiddenEngine {
  private win: BrowserWindow | null = null;
  private boot: { promise: Promise<BrowserWindow>; resolve: (win: BrowserWindow) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private ready = false;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private operations = 0;
  private resources = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleSince?: number;
  private wired = false;
  constructor(private channel: string, private preload: string, private onGone: () => void = () => {}, private log: (message: string) => void = () => {}) {}
  get hasWindow(): boolean { return !!this.win && !this.win.isDestroyed(); }
  private trusted(event: IpcMainEvent): boolean {
    return this.hasWindow && event.sender === this.win!.webContents && event.senderFrame === this.win!.webContents.mainFrame;
  }
  private response = (event: IpcMainEvent, msg: any) => {
    if (!this.trusted(event)) return;
    const pending = this.pending.get(msg?.reqId);
    if (!pending) return;
    this.pending.delete(msg.reqId); if (pending.timer) clearTimeout(pending.timer);
    if (Number.isSafeInteger(msg.activeCount) && msg.activeCount >= 0) this.resources = msg.activeCount;
    if (msg.ok) pending.resolve(msg.data); else pending.reject(new Error(msg.error || 'Sharing engine error'));
  };
  private readied = (event: IpcMainEvent) => {
    if (!this.trusted(event) || !this.boot) return;
    this.ready = true;
    const boot = this.boot; this.boot = null; clearTimeout(boot.timer); boot.resolve(this.win!);
  };
  private logged = (event: IpcMainEvent, message: unknown) => { if (this.trusted(event)) this.log(String(message)); };
  private counted = (event: IpcMainEvent, count: unknown) => {
    if (!this.trusted(event) || !Number.isSafeInteger(count) || (count as number) < 0) return;
    this.resources = count as number; this.scheduleIdle();
  };
  private wire(): void {
    if (this.wired) return; this.wired = true;
    ipcMain.on(this.channel + '-res', this.response);
    ipcMain.on(this.channel + '-ready', this.readied);
    ipcMain.on(this.channel + '-log', this.logged);
    ipcMain.on(this.channel + '-count', this.counted);
  }
  private cancelIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; }
  private scheduleIdle(): void {
    this.cancelIdle();
    if (this.resources) this.idleSince = undefined;
    if (!this.hasWindow || this.operations || this.resources) return;
    const win = this.win!;
    this.idleSince ??= Date.now();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.win === win && !this.operations && !this.resources) this.gone(win, 'Sharing engine is idle');
    }, Math.max(0, 5000 - (Date.now() - this.idleSince)));
    this.idleTimer.unref?.();
  }
  private gone(win: BrowserWindow, message: string): void {
    if (this.win !== win) return;
    this.cancelIdle(); this.idleSince = undefined; this.win = null; this.ready = false; this.resources = 0;
    const error = new Error(message);
    if (this.boot) { clearTimeout(this.boot.timer); this.boot.reject(error); this.boot = null; }
    for (const pending of this.pending.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onGone();
    if (!win.isDestroyed()) { try { win.destroy(); } catch { /* already closing */ } }
  }
  private ensureWindow(): Promise<BrowserWindow> {
    this.wire();
    if (this.hasWindow && this.ready) return Promise.resolve(this.win!);
    if (this.boot) return this.boot.promise;
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false,
    } });
    this.win = win; this.ready = false;
    let resolve!: (win: BrowserWindow) => void, reject!: (error: Error) => void;
    const promise = new Promise<BrowserWindow>((res, rej) => { resolve = res; reject = rej; });
    this.boot = { promise, resolve, reject, timer: setTimeout(() => this.gone(win, 'Sharing engine did not start within 20 seconds'), 20000) };
    win.on('closed', () => this.gone(win, 'Sharing engine closed'));
    win.webContents.on('preload-error', (_event, _path, error) => this.gone(win, String(error)));
    win.webContents.on('render-process-gone', () => this.gone(win, 'Sharing engine crashed. Please try again.'));
    try { void win.loadURL('about:blank').catch(error => this.gone(win, String(error))); }
    catch (error) { this.gone(win, String(error)); }
    return promise;
  }
  async call<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    // UI polling must not postpone retirement of an otherwise empty engine.
    if (type !== 'get' && type !== 'list') this.idleSince = undefined;
    this.operations++; this.cancelIdle();
    try {
      const win = await this.ensureWindow();
      if (this.win !== win || win.isDestroyed()) throw new Error('Sharing engine closed');
      const reqId = ++this.seq;
      return await new Promise<T>((resolve, reject) => {
        const pending: Pending = { resolve, reject };
        if (timeoutMs > 0) pending.timer = setTimeout(() => {
          if (this.pending.delete(reqId)) reject(new Error('Sharing engine did not respond'));
        }, timeoutMs);
        this.pending.set(reqId, pending);
        try { win.webContents.send(this.channel + '-cmd', { type, reqId, ...payload }); }
        catch (error) { this.pending.delete(reqId); if (pending.timer) clearTimeout(pending.timer); reject(error); }
      });
    } finally { this.operations--; this.scheduleIdle(); }
  }
  destroy(): void {
    if (this.win) this.gone(this.win, 'Shutting down');
    this.cancelIdle();
    if (this.wired) {
      ipcMain.removeListener(this.channel + '-res', this.response);
      ipcMain.removeListener(this.channel + '-ready', this.readied);
      ipcMain.removeListener(this.channel + '-log', this.logged);
      ipcMain.removeListener(this.channel + '-count', this.counted);
      this.wired = false;
    }
  }
}
