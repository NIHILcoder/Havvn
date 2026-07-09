/**
 * RemoteCastManager — main-process proxy for "Watch anywhere" (remote streaming
 * over WebRTC). Owns a hidden BrowserWindow whose preload (remote-cast-engine)
 * runs the WebRTC rendezvous + ffmpeg transcode, and hands back a public link
 * (GitHub Pages receiver + a random session id) that plays the stream in any
 * browser, on any network.
 */

import path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import crypto from 'crypto';
import { logger } from '../utils';
import * as db from '../db/store';
import { getTorrentManager } from '../torrent';

const log = logger.child('RemoteCast');

// Post-rebrand GitHub Pages URL (repo renamed to Havvn) — see share-seeder.ts RECEIVER_BASE.
const RECEIVER_BASE = 'https://nihilcoder.github.io/Havvn/watch/';
import { customTurnToIce } from './ice-servers';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class RemoteCastManager {
  private win: BrowserWindow | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pending = new Map<number, Pending>();
  private reqSeq = 0;
  private ipcWired = false;
  // (downloadId/fileIndex) → active sessionId, so a re-publish reuses it.
  private active = new Map<string, string>();

  private wireIpc(): void {
    if (this.ipcWired) return;
    this.ipcWired = true;
    ipcMain.on('rcast-res', (_e, msg: any) => {
      const p = this.pending.get(msg?.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'Remote-cast error'));
    });
    ipcMain.on('rcast-ready', () => {
      this.ready = true;
      const waiters = this.readyWaiters; this.readyWaiters = [];
      waiters.forEach((f) => f());
    });
    ipcMain.on('rcast-log', (_e, m: any) => log.info('Engine', { msg: String(m) }));
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
    const preload = path.join(__dirname, 'remote-cast-engine.js');
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, nodeIntegration: false, contextIsolation: false, sandbox: false, backgroundThrottling: false },
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.warn('Remote-cast window gone', { reason: details?.reason });
      this.failAll('Remote streaming stopped unexpectedly (the engine crashed).');
      this.ready = false;
      if (this.win === win) this.win = null;
    });
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; } });
    this.win = win;
    await win.loadURL('about:blank');
    if (!this.ready) await new Promise<void>((res) => this.readyWaiters.push(res));
    return win;
  }

  private async call<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 0): Promise<T> {
    const win = await this.ensureWindow();
    const reqId = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      if (timeoutMs > 0) setTimeout(() => { if (this.pending.delete(reqId)) reject(new Error('Remote-cast engine did not respond')); }, timeoutMs);
      win.webContents.send('rcast-cmd', { type, reqId, ...payload });
    });
  }

  /** Publish a file for remote viewing; returns the shareable watch link. */
  async start(downloadId: string, fileIndex: number): Promise<{ url: string; sessionId: string }> {
    const info = await getTorrentManager().getCastFileInfo(downloadId, fileIndex);
    if (!info) throw new Error('File not available');
    if (info.kind === 'other') throw new Error('This file is not a playable media file');
    const ffmpeg = getTorrentManager().ffmpegBinary;
    if (!ffmpeg) throw new Error('Remote streaming needs the bundled ffmpeg, which is unavailable');

    const key = `${downloadId}/${fileIndex}`;
    let sessionId = this.active.get(key);
    if (!sessionId) {
      sessionId = crypto.randomBytes(16).toString('hex');
      this.active.set(key, sessionId);
    }
    let useTurn = true;
    let turnServers: ReturnType<typeof customTurnToIce> = [];
    try {
      const s = await db.getSettings();
      useTurn = s.shareUseTurn !== false;
      turnServers = customTurnToIce(s.customTurnUrl, s.customTurnUsername, s.customTurnCredential);
    } catch { /* default on, no custom TURN */ }

    await this.call('start', { payload: { id: sessionId, contentPath: info.diskPath, ffmpeg, useTurn, turnServers } }, 15000);
    const url = RECEIVER_BASE + '#' + sessionId + (useTurn ? '' : '|nt');
    return { url, sessionId };
  }

  async stop(sessionId: string): Promise<{ ok: boolean }> {
    for (const [k, v] of this.active) if (v === sessionId) this.active.delete(k);
    try { await this.call('stop', { id: sessionId }, 8000); } catch { /* engine may be down */ }
    return { ok: true };
  }

  destroy(): void {
    this.failAll('Shutting down');
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy(); } catch { /* ignore */ } }
    this.win = null; this.ready = false;
    log.info('RemoteCastManager destroyed');
  }
}

let remoteCastManager: RemoteCastManager | null = null;
export function getRemoteCastManager(): RemoteCastManager {
  if (!remoteCastManager) remoteCastManager = new RemoteCastManager();
  return remoteCastManager;
}
