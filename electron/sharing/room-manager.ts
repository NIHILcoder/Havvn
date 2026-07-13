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
import { BrowserWindow, ipcMain, app, shell } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils';
import * as db from '../db/store';
import { RoomState, RoomSummary, RoomProfile } from '../../shared/types';
import { generateRoomCode, normalizeCode, codeIsE2E } from './room-crypto';
import { generateRoomSecret } from './room-e2e';

const log = logger.child('RoomManager');

// Same relay set as share links — friends behind symmetric NATs need TURN to
// connect. Honors the existing "Use TURN relays" privacy toggle.
import { customTurnToIce } from './ice-servers';

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

  constructor() {
    // Renderer-facing liveness channels live HERE (not ipc/handlers.ts): they
    // are room-stack plumbing end to end, and the singleton constructor makes
    // the ipcMain.handle registration run exactly once.
    ipcMain.handle('rooms:typing', async (_e, roomId: string) => { this.typing(String(roomId || '')); return { ok: true }; });
    ipcMain.handle('rooms:reactFile', async (_e, roomId: string, fileId: string, emoji: string) =>
      this.reactFile(String(roomId || ''), String(fileId || ''), String(emoji || '')));
  }

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
    // Watch-together: forward a peer's playback control to the renderer player.
    ipcMain.on('room-sync', (_e, payload: any) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:sync', payload);
      }
    });
    // A peer deleted a file — persist the tombstone so it stays gone after restart.
    ipcMain.on('room-tomb', (_e, payload: { roomId: string; fileId: string; at?: number }) => {
      try { if (payload?.roomId && payload?.fileId) db.addRoomTombstone(payload.roomId, payload.fileId, Number(payload.at) || Date.now()); } catch { /* ignore */ }
    });
    // A file was explicitly re-shared after deletion — lift the persisted
    // tombstone so the revive survives restart.
    ipcMain.on('room-tomb-del', (_e, payload: { roomId: string; fileId: string }) => {
      try { if (payload?.roomId && payload?.fileId) db.removeRoomTombstone(payload.roomId, payload.fileId); } catch { /* ignore */ }
    });
    // A file entered/changed in a room's manifest — persist it so the room shows
    // and re-seeds it immediately on the next launch, before peers reconnect.
    ipcMain.on('room-manifest-add', (_e, payload: { roomId: string; file: import('../../shared/types').PersistedRoomFile }) => {
      try { if (payload?.roomId && payload?.file?.fileId) db.upsertRoomManifestFile(payload.roomId, payload.file); } catch { /* ignore */ }
    });
    ipcMain.on('room-manifest-del', (_e, payload: { roomId: string; fileId: string }) => {
      try { if (payload?.roomId && payload?.fileId) db.removeRoomManifestFile(payload.roomId, payload.fileId); } catch { /* ignore */ }
    });
    // A folder was created/edited (ours or a peer's) — persist so it (and the
    // file grouping) survives restart, before peers reconnect.
    ipcMain.on('room-folder-upsert', (_e, payload: { roomId: string; folder: import('../../shared/types').PersistedRoomFolder }) => {
      try { if (payload?.roomId && payload?.folder?.id) db.upsertRoomFolder(payload.roomId, payload.folder); } catch { /* ignore */ }
    });
    // A folder was deleted — persist the tombstone; drop it from the set ONLY if
    // the engine actually removed it (an edit-after-delete keeps a newer folder
    // live, and dropping it here would make it vanish on the next restart).
    ipcMain.on('room-folder-del', (_e, payload: { roomId: string; id: string; at?: number; removed?: boolean }) => {
      try {
        if (payload?.roomId && payload?.id) {
          db.addRoomFolderTombstone(payload.roomId, payload.id, Number(payload.at) || Date.now());
          if (payload.removed !== false) db.removeRoomFolder(payload.roomId, payload.id);
        }
      } catch { /* ignore */ }
    });
    // A new activity-log event was observed — persist it (capped) so the room's
    // history survives restart.
    ipcMain.on('room-history-add', (_e, payload: { roomId: string; event: import('../../shared/types').RoomEvent }) => {
      try { if (payload?.roomId && payload?.event?.id) db.appendRoomEvents(payload.roomId, [payload.event]); } catch { /* ignore */ }
    });
    // A chat message (sent or received) — persist it (capped, deduped by id).
    ipcMain.on('room-chat-add', (_e, payload: { roomId: string; message: import('../../shared/types').RoomChatMessage }) => {
      try { if (payload?.roomId && payload?.message?.id) db.appendRoomChats(payload.roomId, [payload.message]); } catch { /* ignore */ }
    });
    // A file reaction toggled (ours or a peer's) — persist the room's whole
    // reaction map (toggles don't append well) so it survives restart.
    ipcMain.on('room-reacts', (_e, payload: { roomId: string; reacts: Record<string, Record<string, string[]>> }) => {
      try { if (payload?.roomId && payload?.reacts) db.setRoomReacts(payload.roomId, payload.reacts); } catch { /* ignore */ }
    });
    // The engine TOFU-bound a member's public key — persist so the binding (and
    // thus anti-impersonation) survives restarts.
    ipcMain.on('room-identity-add', (_e, payload: { roomId: string; memberId: string; pub: string }) => {
      try { if (payload?.roomId && payload?.memberId && payload?.pub) db.addRoomIdentity(payload.roomId, payload.memberId, payload.pub); } catch { /* ignore */ }
    });
    // A joiner learned who the room owner is from a peer — persist it.
    ipcMain.on('room-owner', (_e, payload: { roomId: string; ownerId: string }) => {
      try {
        if (!payload?.roomId || !payload?.ownerId) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        if (r && r.ownerId !== payload.ownerId) {
          db.savePersistedRoom({ ...r, ownerId: payload.ownerId });
          log.info('Room owner learned from peer', { roomId: payload.roomId });
        }
      } catch { /* ignore */ }
    });
    // The room was rekeyed (a member was kicked) — persist the new invite code so
    // reconnecting/restarting lands on the new swarm, not the abandoned one.
    ipcMain.on('room-rekey', (_e, payload: { roomId: string; code: string }) => {
      try {
        if (!payload?.roomId || !payload?.code) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        if (r && r.code !== payload.code) {
          db.savePersistedRoom({ ...r, code: payload.code });
          log.info('Room rekeyed', { roomId: payload.roomId });
        }
      } catch { /* ignore */ }
    });
    // A joiner learned the room's E2E mode + content secret from a peer — persist
    // them (with the owner-signed config blob, so it can be re-verified and
    // re-served after restart) so encrypted files keep decrypting.
    ipcMain.on('room-e2e', (_e, payload: { roomId: string; e2e: boolean; secret: string; cfg?: db.PersistedRoom['e2eCfg'] }) => {
      try {
        if (!payload?.roomId) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        const cfg = payload.cfg || undefined;
        if (r && (r.e2e !== payload.e2e || r.secret !== payload.secret || r.e2eCfg?.sig !== cfg?.sig)) {
          db.savePersistedRoom({ ...r, e2e: payload.e2e, secret: payload.secret, e2eCfg: cfg });
          log.info('Room E2E config learned from peer', { roomId: payload.roomId, e2e: payload.e2e, signed: !!cfg });
        }
      } catch { /* ignore */ }
    });
    // A joiner learned the room's friendly name from a peer (it had only the
    // code) — persist it so the name survives restart and shows in the list even
    // before the room reconnects. Live UI updates ride the normal room-update.
    ipcMain.on('room-name', (_e, payload: { roomId: string; name: string }) => {
      try {
        if (!payload?.roomId || !payload?.name) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        if (r && r.name !== payload.name) {
          db.savePersistedRoom({ ...r, name: payload.name });
          log.info('Room name learned from peer', { roomId: payload.roomId, name: payload.name });
        }
      } catch { /* ignore */ }
    });
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
    catch { base = path.join(app.getPath('downloads'), 'Havvn'); }
    return path.join(base, 'Rooms');
  }

  /** Where a room's ciphertext copies live in E2E mode (outside the room folder). */
  private encCacheDir(roomId: string): string {
    return path.join(app.getPath('userData'), 'room-enc', roomId);
  }

  private async joinPayload(roomId: string, name: string, code: string, folder: string, ownerId?: string, e2e?: boolean, secret?: string, e2eCfg?: db.PersistedRoom['e2eCfg']) {
    const profile = db.getRoomProfile();
    const identity = db.getRoomIdentity();
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    let useTurn = true;
    let turnServers: ReturnType<typeof customTurnToIce> = [];
    try {
      const s = await db.getSettings();
      useTurn = s.shareUseTurn !== false;
      turnServers = customTurnToIce(s.customTurnUrl, s.customTurnUsername, s.customTurnCredential);
    } catch { /* default on, no custom TURN */ }
    return {
      type: 'join',
      payload: {
        roomId, name, code, folder,
        self: { memberId: profile.memberId, name: profile.name, avatarSeed: profile.avatarSeed, pub: identity.pub, priv: identity.priv },
        useTurn,
        turnServers,
        tombstones: db.getRoomTombstones(roomId),
        manifest: db.getRoomManifest(roomId),
        folders: db.getRoomFolders(roomId),
        folderTombs: db.getRoomFolderTombstones(roomId),
        ownerId: ownerId ?? '',
        mutes: db.getRoomMutes(roomId),
        history: db.getRoomHistory(roomId),
        chat: db.getRoomChats(roomId),
        reacts: db.getRoomReacts(roomId),
        identities: db.getRoomIdentities(roomId),
        e2e: e2e ?? false,
        secret: secret ?? '',
        e2eCfg: e2eCfg ?? null,
        cacheDir: this.encCacheDir(roomId),
        // Per-room preferences (absent → auto-download on, no speed limits).
        autoFetch: persisted?.autoFetch !== false,
        upKbps: persisted?.upKbps ?? 0,
        downKbps: persisted?.downKbps ?? 0,
      },
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  getProfile(): RoomProfile { return db.getRoomProfile(); }

  setProfile(updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed'>>): RoomProfile {
    const profile = db.updateRoomProfile(updates);
    // Push the change into the live engine so active rooms re-broadcast the new
    // identity to peers immediately (no rejoin needed). Skip if not running yet.
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'profile', reqId: ++this.reqSeq, payload: { name: profile.name, avatarSeed: profile.avatarSeed } });
    }
    return profile;
  }

  async createRoom(name: string, e2e = false): Promise<RoomState> {
    const roomId = uuidv4();
    const code = generateRoomCode(e2e); // E2E rooms carry the marker in the code itself
    const folder = path.join(await this.roomsBase(), slugify(name) + '-' + roomId.slice(0, 6));
    fs.mkdirSync(folder, { recursive: true });
    const createdAt = Date.now();
    const ownerId = db.getRoomProfile().memberId; // the creator owns the room
    // E2E rooms get a content secret (separate from the rotating gossip key) so a
    // later kick/rekey doesn't strand access to already-shared files.
    const secret = e2e ? generateRoomSecret() : undefined;
    db.savePersistedRoom({ roomId, name, code, folder, createdAt, ownerId, e2e, secret });
    const { type, payload } = await this.joinPayload(roomId, name, code, folder, ownerId, e2e, secret);
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
    const name = code; // placeholder until a peer's HELLO/PING carries the real name
    const folder = path.join(await this.roomsBase(), slugify(code) + '-' + roomId.slice(0, 6));
    fs.mkdirSync(folder, { recursive: true });
    const createdAt = Date.now();
    // A "-e2e" code tells us the room is end-to-end encrypted before any peer
    // does — so the engine refuses to seed plaintext even into an empty swarm.
    const e2e = codeIsE2E(code);
    db.savePersistedRoom({ roomId, name, code, folder, createdAt, e2e });
    const { type, payload } = await this.joinPayload(roomId, name, code, folder, undefined, e2e);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  private async reactivate(r: db.PersistedRoom): Promise<RoomState> {
    const { type, payload } = await this.joinPayload(r.roomId, r.name, r.code, r.folder, r.ownerId, r.e2e, r.secret, r.e2eCfg);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = r.createdAt;
    this.cache.set(r.roomId, state);
    return state;
  }

  /**
   * Leave a room. By default the downloaded files stay on disk; pass
   * `deleteFiles` to also remove the room's download folder (files a member
   * shared from their ORIGINAL location outside the folder are untouched).
   */
  async leaveRoom(roomId: string, deleteFiles = false): Promise<{ ok: boolean }> {
    // Resolve the folder BEFORE the db entry is deleted below.
    const folder = deleteFiles ? this.folderOf(roomId) : null;
    try { await this.call('leave', { roomId }, 8000); } catch { /* engine may be down */ }
    db.deletePersistedRoom(roomId);
    db.clearRoomTombstones(roomId);
    db.clearRoomManifest(roomId);
    db.clearRoomFolders(roomId);
    db.clearRoomHistory(roomId);
    db.clearRoomMutes(roomId);
    db.clearRoomChats(roomId);
    db.clearRoomReacts(roomId);
    db.clearRoomIdentities(roomId);
    try { fs.rmSync(this.encCacheDir(roomId), { recursive: true, force: true }); } catch { /* ignore */ }
    // The engine's 'leave' above destroys the room's WebTorrent client, so the
    // file handles should be released by now; best-effort delete (a Windows AV
    // lock can still hold one, in which case the folder simply stays).
    if (folder) {
      try { fs.rmSync(folder, { recursive: true, force: true }); }
      catch (e) { log.warn('leaveRoom: could not delete room folder', { roomId, err: String(e) }); }
    }
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
        e2e: r.e2e ?? false,
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

  async addFiles(roomId: string, paths: string[], opts?: { folderId?: string; folderName?: string }): Promise<RoomState> {
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    const state = await this.call<RoomState>('addFiles', { roomId, paths, opts });
    state.createdAt = persisted.createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  folderOf(roomId: string): string | null {
    return db.getPersistedRooms().find((r) => r.roomId === roomId)?.folder ?? null;
  }

  /**
   * Open a room file from disk. First tells the engine to stop seeding it so
   * Windows releases the file handle (otherwise archives can't be opened while
   * the file is being shared), then opens it with the OS default app.
   */
  async openFile(roomId: string, fileId: string): Promise<void> {
    const state = this.cache.get(roomId);
    const file = state?.files.find((f) => f.fileId === fileId);
    const folder = this.folderOf(roomId);
    try { await this.call('releaseFile', { roomId, fileId }, 8000); } catch { /* engine may be down */ }
    // Prefer the engine-known on-disk path (a folder subdir for foldered files,
    // or a shared file's original location); fall back to the flat room join.
    const tr = state?.transfers?.[fileId];
    const abs = (tr?.localPath && fs.existsSync(tr.localPath)) ? tr.localPath
      : (folder && file) ? path.join(folder, file.name) : null;
    if (abs) {
      try { await shell.openPath(abs); } catch { /* ignore */ }
    }
  }

  /**
   * Resolve a downloaded room file on disk and publish it on the cast server,
   * returning ready media URLs for the in-app player.
   */
  async watchFile(roomId: string, fileId: string): Promise<{ directUrl: string; hlsUrl: string; playerUrl: string; coverUrl?: string; direct: boolean; kind: string; name: string }> {
    const state = this.cache.get(roomId);
    const file = state?.files.find((f) => f.fileId === fileId);
    const folder = this.folderOf(roomId);
    if (!file || !folder) throw new Error('File not available in this room');
    // Prefer the engine-known on-disk path: a *shared* file is seeded from its
    // original location (not the room folder), while a *downloaded* one lives in
    // the room folder. Fall back to the room folder for older state.
    const tr = state?.transfers?.[fileId];
    const abs = (tr?.localPath && fs.existsSync(tr.localPath)) ? tr.localPath : path.join(folder, file.name);
    if (!fs.existsSync(abs)) throw new Error('This file is not fully downloaded yet');
    // The cast server runs in the torrent host; publish the room file there.
    const { getTorrentManager } = await import('../torrent');
    return getTorrentManager().castPublishDiskFile(abs);
  }

  // ── Folders / sections ──────────────────────────────────────────────────────
  /** Route a folder command through a live engine (reactivating the room if idle). */
  private async folderCmd(roomId: string, type: string, extra: Record<string, unknown>): Promise<RoomState> {
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    const state = await this.call<RoomState>(type, { roomId, ...extra });
    state.createdAt = persisted.createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  createFolder(roomId: string, name: string, icon: string, color: string): Promise<RoomState> {
    return this.folderCmd(roomId, 'createFolder', { name, icon, color });
  }
  updateFolder(roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string }): Promise<RoomState> {
    return this.folderCmd(roomId, 'updateFolder', { folderId, patch });
  }
  deleteFolder(roomId: string, folderId: string): Promise<RoomState> {
    return this.folderCmd(roomId, 'deleteFolder', { folderId });
  }
  assignFile(roomId: string, fileId: string, folderId: string | null): Promise<RoomState> {
    return this.folderCmd(roomId, 'assignFile', { fileId, folderId });
  }

  /** Remove a shared file from the room for everyone (persists a tombstone). */
  async removeFile(roomId: string, fileId: string): Promise<{ ok: boolean }> {
    const at = Date.now(); // one timestamp for the persisted tombstone AND the gossip 'del'
    db.addRoomTombstone(roomId, fileId, at);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'removeFile', reqId: ++this.reqSeq, roomId, fileId, at });
    }
    return { ok: true };
  }

  /** Owner-only: remove a member by rotating the room code (engine enforces it). */
  async kick(roomId: string, memberId: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('kick', { roomId, memberId }, 8000);
  }

  /** Locally hide/ignore a member on this install (reversible, never broadcast). */
  async setMuted(roomId: string, memberId: string, muted: boolean): Promise<{ ok: boolean }> {
    db.setRoomMute(roomId, memberId, muted);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'mute', reqId: ++this.reqSeq, roomId, memberId, muted });
    }
    return { ok: true };
  }

  /** Auto-download files peers share into this room (persisted per room).
   *  Turning it back on also pulls everything left unfetched. */
  async setAutoFetch(roomId: string, autoFetch: boolean): Promise<{ ok: boolean }> {
    db.setRoomAutoFetch(roomId, autoFetch);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'setAutoFetch', reqId: ++this.reqSeq, roomId, autoFetch });
    }
    return { ok: true };
  }

  /** Manual mode: explicitly download one shared file. Returns the fresh state. */
  async fetchFile(roomId: string, fileId: string): Promise<RoomState> {
    return this.call<RoomState>('fetchFile', { roomId, fileId }, 8000);
  }

  /** Per-room speed ceilings in KB/s, 0 = unlimited (persisted + applied live). */
  async setLimits(roomId: string, upKbps: number, downKbps: number): Promise<{ ok: boolean }> {
    const up = Math.max(0, Math.floor(Number(upKbps) || 0));
    const down = Math.max(0, Math.floor(Number(downKbps) || 0));
    db.setRoomLimits(roomId, up, down);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'setLimits', reqId: ++this.reqSeq, roomId, upKbps: up, downKbps: down });
    }
    return { ok: true };
  }

  /** Watch-together: broadcast a local playback action to the room's peers. */
  broadcastSync(roomId: string, payload: { fileId: string; action: string; position: number; rate?: number; playing?: boolean; emoji?: string }): void {
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'sync', reqId: ++this.reqSeq, roomId, payload });
    }
  }

  /** Send a chat message to a room (broadcast to peers + recorded locally). */
  async sendChat(roomId: string, text: string): Promise<{ ok: boolean }> {
    const body = String(text || '').trim();
    if (!body) return { ok: false };
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'chat', reqId: ++this.reqSeq, roomId, payload: { text: body } });
    }
    return { ok: true };
  }

  /** Fire-and-forget: tell a room's peers we're composing a chat message.
   *  The engine rate-limits the broadcast, so keystroke-driven calls are fine. */
  typing(roomId: string): void {
    if (!roomId) return;
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'typing', reqId: ++this.reqSeq, roomId });
    }
  }

  /** Toggle our emoji reaction on a shared file (whitelisted emoji only;
   *  the engine flips on/off from its current state and gossips the change). */
  async reactFile(roomId: string, fileId: string, emoji: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('reactFile', { roomId, fileId, emoji }, 8000);
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
