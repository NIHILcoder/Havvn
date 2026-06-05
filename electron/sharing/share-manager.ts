/**
 * ShareManager — "Instant Share Links" (Phase 2 of the P2P hub).
 *
 * Runs the WebTorrent seeder in a hidden BrowserWindow (see share-seeder.ts)
 * so it uses Chromium's native WebRTC — the native @roamhq/wrtc module crashes
 * under Electron when a connection is established. This main-process class is a
 * thin message-passing proxy to that window. If the window's renderer crashes,
 * the app survives and the window respawns on the next share.
 */

import path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import { logger } from '../utils';
import { ShareInfo } from '../../shared/types';

const log = logger.child('ShareManager');

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class ShareManager {
  private win: BrowserWindow | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pending: Map<number, Pending> = new Map();
  private reqSeq = 0;
  private ipcWired = false;

  private wireIpc(): void {
    if (this.ipcWired) return;
    this.ipcWired = true;
    ipcMain.on('share-res', (_e, msg: any) => {
      const p = this.pending.get(msg?.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'Share error'));
    });
    ipcMain.on('share-ready', () => {
      this.ready = true;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((f) => f());
    });
    ipcMain.on('share-log', (_e, m: any) => log.info('Seeder', { msg: String(m) }));
  }

  private failAll(message: string): void {
    for (const [, p] of this.pending) p.reject(new Error(message));
    this.pending.clear();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    this.wireIpc();
    if (this.win && !this.win.isDestroyed()) {
      if (this.ready) return this.win;
      await new Promise<void>((res) => this.readyWaiters.push(res));
      return this.win;
    }

    this.ready = false;
    const preload = path.join(__dirname, 'share-seeder.js');
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        nodeIntegration: false,
        contextIsolation: false, // preload shares the page window (native WebRTC)
        sandbox: false,          // allow require() in the preload
        backgroundThrottling: false, // keep seeding/WebRTC alive while hidden
      },
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      log.warn('Share window renderer gone', { reason: details?.reason });
      this.failAll('Sharing stopped unexpectedly (the share window crashed). Please try again.');
      this.ready = false;
      if (this.win === win) this.win = null;
    });
    win.on('closed', () => {
      if (this.win === win) { this.win = null; this.ready = false; }
    });

    this.win = win;
    await win.loadURL('about:blank');
    if (!this.ready) await new Promise<void>((res) => this.readyWaiters.push(res));
    log.info('Share window ready');
    return win;
  }

  private async call<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 0): Promise<T> {
    const win = await this.ensureWindow();
    const reqId = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.pending.delete(reqId)) reject(new Error('Share window did not respond'));
        }, timeoutMs);
      }
      win.webContents.send('share-cmd', { type, reqId, ...payload });
    });
  }

  /** Start sharing a completed download's content (seeded from disk). */
  share(downloadId: string, contentPath: string, name: string, useTurn: boolean): Promise<ShareInfo> {
    // No timeout: hashing a large file before seeding can take a while.
    return this.call<ShareInfo>('share', { downloadId, contentPath, name, useTurn });
  }

  stop(downloadId: string): Promise<{ ok: boolean }> {
    return this.call('stop', { downloadId }, 8000);
  }

  get(downloadId: string): Promise<(ShareInfo & { peers: number }) | null> {
    return this.call('get', { downloadId }, 8000);
  }

  list(): Promise<ShareInfo[]> {
    return this.call('list', {}, 8000);
  }

  destroy(): void {
    this.failAll('Shutting down');
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch { /* ignore */ }
    }
    this.win = null;
    this.ready = false;
    log.info('ShareManager destroyed');
  }
}

let shareManager: ShareManager | null = null;
export function getShareManager(): ShareManager {
  if (!shareManager) shareManager = new ShareManager();
  return shareManager;
}

/** Helper: absolute path to a download's content on disk. */
export function downloadContentPath(savePath: string, name: string): string {
  return path.join(savePath, name);
}
