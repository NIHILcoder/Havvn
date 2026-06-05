/**
 * RoomManager — main-process proxy for friend swarms (Phase 3).
 *
 * Mirrors ShareManager: it owns a hidden BrowserWindow whose preload
 * (room-engine.ts) runs the actual WebRTC rendezvous + WebTorrent transfers,
 * and it message-passes commands to it. On top of that it:
 *   • persists joined rooms (electron-store) and re-joins them on startup,
 *   • supplies this install's identity + ICE/TURN config to the engine,
 *   • caches the latest RoomState per room and forwards live updates to the
 *     renderer (channel 'rooms:update').
 */

import path from 'path';
import fs from 'fs';
import { BrowserWindow, ipcMain, app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils';
import * as db from '../db/store';
import { RoomState, RoomSummary, RoomProfile } from '../../shared/types';
import { generateRoomCode, normalizeCode } from './room-crypto';

const log = logger.child('RoomManager');

// Same relay set as share links — friends behind symmetric NATs need TURN to
// connect. Honors the existing "Use TURN relays" privacy toggle.
const TURN_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'room';
}

export class RoomManager {
  private win: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pending = new Map<number, Pending>();
  private reqSeq = 0;
  private ipcWired = false;
  private cache = new Map<string, RoomState>();

  setMainWindow(win: BrowserWindow): void { this.mainWindow = win; }

  private wireIpc(): void {
    if (this.ipcWired) return;
    this.ipcWired = true;
    ipcMain.on('room-res', (_e, msg: any) => {
      const p = this.pending.get(msg?.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'Room error'));
    });
    ipcMain.on('room-ready', () => {
      this.ready = true;
      const waiters = this.readyWaiters; this.readyWaiters = [];
      waiters.forEach((f) => f());
    });
    ipcMain.on('room-update', (_e, state: RoomState) => {
      if (state?.roomId) this.cache.set(state.roomId, state);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:update', state);
      }
    });
    ipcMain.on('room-log', (_e, m: any) => log.info('Engine', { msg: String(m) }));
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
    const preload = path.join(__dirname, 'room-engine.js');
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        nodeIntegration: false,
        contextIsolation: false, // preload shares the page window (native WebRTC)
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.warn('Room window renderer gone', { reason: details?.reason });
      this.failAll('Room networking stopped unexpectedly (the engine crashed).');
      this.ready = false;
      if (this.win === win) this.win = null;
    });
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; } });
    this.win = win;
    await win.loadURL('about:blank');
    if (!this.ready) await new Promise<void>((res) => this.readyWaiters.push(res));
    log.info('Room window ready');
    return win;
  }

  private async call<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 0): Promise<T> {
    const win = await this.ensureWindow();
    const reqId = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      if (timeoutMs > 0) setTimeout(() => { if (this.pending.delete(reqId)) reject(new Error('Room engine did not respond')); }, timeoutMs);
      win.webContents.send('room-cmd', { type, reqId, ...payload });
    });
  }

  private async roomsBase(): Promise<string> {
    let base: string;
    try { base = (await db.getSettings()).defaultDownloadDir; }
    catch { base = path.join(app.getPath('downloads'), 'TorrentHunt'); }
    return path.join(base, 'Rooms');
  }

  private async joinPayload(roomId: string, name: string, code: string, folder: string) {
    const profile = db.getRoomProfile();
    let useTurn = true;
    try { useTurn = (await db.getSettings()).shareUseTurn !== false; } catch { /* default on */ }
    return {
      type: 'join',
      payload: {
        roomId, name, code, folder,
        self: { memberId: profile.memberId, name: profile.name, avatarSeed: profile.avatarSeed },
        useTurn,
        turnServers: TURN_SERVERS,
      },
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  getProfile(): RoomProfile { return db.getRoomProfile(); }
  setProfile(updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed'>>): RoomProfile { return db.updateRoomProfile(updates); }

  async createRoom(name: string): Promise<RoomState> {
    const roomId = uuidv4();
    const code = generateRoomCode();
    const folder = path.join(await this.roomsBase(), slugify(name) + '-' + roomId.slice(0, 6));
    fs.mkdirSync(folder, { recursive: true });
    const createdAt = Date.now();
    db.savePersistedRoom({ roomId, name, code, folder, createdAt });
    const { type, payload } = await this.joinPayload(roomId, name, code, folder);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  async joinRoom(rawCode: string): Promise<RoomState> {
    const code = normalizeCode(rawCode);
    if (!code) throw new Error('Empty room code');
    // Already joined this code? Return the existing room.
    const existing = db.getPersistedRooms().find((r) => normalizeCode(r.code) === code);
    if (existing) return this.getRoom(existing.roomId).then((s) => s || this.reactivate(existing));
    const roomId = uuidv4();
    const name = code; // until peers share a friendlier name in HELLO (future)
    const folder = path.join(await this.roomsBase(), slugify(code) + '-' + roomId.slice(0, 6));
    fs.mkdirSync(folder, { recursive: true });
    const createdAt = Date.now();
    db.savePersistedRoom({ roomId, name, code, folder, createdAt });
    const { type, payload } = await this.joinPayload(roomId, name, code, folder);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  private async reactivate(r: db.PersistedRoom): Promise<RoomState> {
    const { type, payload } = await this.joinPayload(r.roomId, r.name, r.code, r.folder);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = r.createdAt;
    this.cache.set(r.roomId, state);
    return state;
  }

  async leaveRoom(roomId: string): Promise<{ ok: boolean }> {
    try { await this.call('leave', { roomId }, 8000); } catch { /* engine may be down */ }
    db.deletePersistedRoom(roomId);
    this.cache.delete(roomId);
    return { ok: true };
  }

  async list(): Promise<RoomSummary[]> {
    return db.getPersistedRooms().map((r) => {
      const s = this.cache.get(r.roomId);
      return {
        roomId: r.roomId,
        name: r.name,
        code: r.code,
        folder: r.folder,
        memberCount: s ? s.members.length : 1,
        onlineCount: s ? s.members.filter((m) => m.online).length : 1,
        fileCount: s ? s.files.length : 0,
        createdAt: r.createdAt,
      };
    });
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const cached = this.cache.get(roomId);
    if (cached) return cached;
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) return null;
    return this.reactivate(persisted).catch(() => null);
  }

  async addFiles(roomId: string, paths: string[]): Promise<RoomState> {
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    const state = await this.call<RoomState>('addFiles', { roomId, paths });
    state.createdAt = persisted.createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  folderOf(roomId: string): string | null {
    return db.getPersistedRooms().find((r) => r.roomId === roomId)?.folder ?? null;
  }

  /** Re-join all persisted rooms on startup so swarms reconnect automatically. */
  async restoreAll(): Promise<void> {
    const persisted = db.getPersistedRooms();
    if (!persisted.length) return;
    log.info('Restoring rooms', { count: persisted.length });
    for (const r of persisted) {
      try { await this.reactivate(r); } catch (e) { log.warn('Room restore failed', { roomId: r.roomId, error: String(e) }); }
    }
  }

  destroy(): void {
    this.failAll('Shutting down');
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy(); } catch { /* ignore */ } }
    this.win = null; this.ready = false;
    log.info('RoomManager destroyed');
  }
}

let roomManager: RoomManager | null = null;
export function getRoomManager(): RoomManager {
  if (!roomManager) roomManager = new RoomManager();
  return roomManager;
}
