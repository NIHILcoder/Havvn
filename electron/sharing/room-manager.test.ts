/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Electron IPC doubles intentionally accept mixed event/command shapes. */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM_RESOURCES } from '../../shared/room-resources';
import { RoomConnectionMonitor } from '../../shared/room-diagnostics';
import type { RoomState } from '../../shared/types';

const env = vi.hoisted(() => ({
  windows: [] as any[], listeners: new Map<string, (...args: any[]) => void>(), handlers: new Map<string, (...args: any[]) => any>(),
  chat: [] as any[], edits: {} as Record<string, any>, draft: { text: '' } as any, lastRead: 0,
  manifestBatch: vi.fn(), historyBatch: vi.fn(), committed: vi.fn(), preferenceWrites: vi.fn(),
  rooms: [] as any[], load: null as null | (() => Promise<void>), autoReady: false, autoReply: false,
  gone: vi.fn(), shutdown: vi.fn(async () => {}),
  captureAccess: null as null | (() => { audio: boolean; video: boolean }),
  resourcePolicy: undefined as import('../../shared/room-resources').RoomResourcePolicy | undefined, resourceError: '',
  commandError: '', saveError: false, partialSaveError: false, cleanupError: false, deleteError: false, folders: new Set<string>(),
  removedEmpty: vi.fn(), removedFiles: vi.fn(), saved: vi.fn(), deleted: vi.fn(),
  verifiedPath: 'D:/rooms/a/.havvn-files/verified/film.mkv', fileError: '', opened: vi.fn(async () => ''), revealed: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => 'D:/mock-user-data', getVersion: () => '3.0.7' }, shell: { openPath: env.opened, showItemInFolder: env.revealed },
  ipcMain: { on: (channel: string, handler: (...args: any[]) => void) => env.listeners.set(channel, handler), handle: (channel: string, handler: (...args: any[]) => any) => env.handlers.set(channel, handler) },
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send: vi.fn((channel: string, command: any) => {
        if (channel !== 'room-cmd' || !env.autoReply) return;
        queueMicrotask(() => env.listeners.get('room-res')?.(
          { sender: this.webContents, senderFrame: this.webContents.mainFrame },
          { reqId: command.reqId, ok: !(command.type === 'join' && env.commandError) && !(command.type === 'verifiedFile' && env.fileError) && !(command.type === 'resourceSettings' && env.resourceError), error: env.commandError || env.fileError || env.resourceError,
            data: command.type === 'join' ? { ...roomState(command.payload.roomId), name: command.payload.name, code: command.payload.code, folder: command.payload.folder, ownerId: command.payload.ownerId }
              : command.type === 'retryConnection' ? roomState(command.roomId) : command.type === 'voiceDevices' ? [] : command.type === 'verifiedFile' ? env.verifiedPath : { ok: true } },
        ));
      }),
    });
    constructor() { super(); env.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    loadFile = vi.fn(() => {
      if (env.autoReady) queueMicrotask(() => env.listeners.get('room-ready')?.({ sender: this.webContents, senderFrame: this.webContents.mainFrame }));
      return env.load ? env.load() : Promise.resolve();
    });
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  },
}));
vi.mock('fs', () => ({ default: {
  existsSync: (folder: string) => env.folders.has(folder), writeFileSync: vi.fn(),
  mkdirSync: (folder: string) => env.folders.add(folder), rmdirSync: env.removedEmpty, rmSync: env.removedFiles,
} }));
vi.mock('./room-engine-policy', () => ({ ROOM_ENGINE_PARTITION: 'persist:havvn-room-engine',
  installRoomEnginePolicy: (_win: unknown, _page: string, access: typeof env.captureAccess) => { env.captureAccess = access; } }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../i18n', () => ({ t: (s: string) => s }));
vi.mock('../db/store', () => {
  const db: Record<string, any> = {
    pruneRoomLocalHistory: () => [],
    upsertRoomManifestFiles: env.manifestBatch, appendRoomEvents: env.historyBatch,
    getPersistedRooms: () => env.rooms,
    getRoomProfile: () => ({ memberId: 'A', name: 'Alice', avatarSeed: 'a' }),
    getRoomIdentity: () => ({ pub: 'pub', priv: 'priv' }),
    getSettings: async () => ({ defaultDownloadDir: 'D:/downloads', roomResources: env.resourcePolicy }),
    updateSettings: async (patch: any) => { if (env.saveError) throw new Error('storage unavailable'); env.resourcePolicy = patch.roomResources; }, getRoomLastRead: () => env.lastRead,
    savePersistedRoom: (room: any) => {
      env.saved(room); if (env.saveError) throw new Error('storage unavailable');
      env.rooms = env.rooms.filter((r) => r.roomId !== room.roomId).concat({ ...room });
      if (env.partialSaveError) throw new Error('partial storage failure');
    },
    deletePersistedRoom: (id: string) => { env.deleted(id); if (env.deleteError) throw new Error('delete failed'); env.rooms = env.rooms.filter((r) => r.roomId !== id); },
  };
  for (const name of ['Tombstones', 'Manifest', 'Folders', 'History', 'Chats']) db['getRoom' + name] = () => [];
  for (const name of ['LanPrefs', 'TombstoneProofs', 'Revives', 'FolderTombstones', 'Mutes', 'Reacts', 'ChatReacts', 'ChatEdits', 'Identities', 'FolderFetch']) db['getRoom' + name] = () => ({});
  for (const name of ['Tombstones', 'TombstoneProofs', 'Revives', 'Manifest', 'Folders', 'History', 'Mutes', 'LanPrefs', 'FolderFetch', 'Chats', 'LastRead', 'Reacts', 'ChatReacts', 'ChatEdits', 'Identities']) db['clearRoom' + name] = vi.fn();
  db.clearRoomTombstones = () => { if (env.cleanupError) throw new Error('cleanup failed'); };
  db.getRoomChats = () => env.chat;
  db.getRoomChatEdits = () => env.edits;
  db.commitRoomChat = (_id: string, message: any) => { if (env.saveError) throw new Error('storage unavailable'); env.committed(message); env.chat.push(message); return { duplicate: false, message }; };
  db.setRoomChatEdits = (_id: string, edits: any) => { if (env.saveError) throw new Error('storage unavailable'); env.edits = edits; };
  db.getRoomChatDraft = () => env.draft;
  db.setRoomChatDraft = (_id: string, draft: any) => { if (env.saveError) throw new Error('storage unavailable'); env.draft = draft; };
  for (const name of ['setRoomLimits', 'setRoomAutoFetch', 'setRoomMute', 'setRoomFolderFetch']) db[name] = (...args: unknown[]) => {
    if (env.saveError) throw new Error('storage unavailable'); env.preferenceWrites(name, ...args);
  };
  return db;
});
vi.mock('../torrent/subtitle-probe', () => ({}));
vi.mock('./room-e2e', () => ({ generateRoomSecret: () => 'content-secret' }));
vi.mock('./room-file-storage', () => ({ roomFileStamp: (candidate: string) => env.folders.has(candidate) ? 'verified-stamp' : undefined }));
vi.mock('../gameserver/server-mirror', () => ({}));
vi.mock('../utils/global-ptt', () => ({ decideGlobalPtt: () => ({ run: false }), stopGlobalPtt: vi.fn(), isGlobalPttAvailable: () => false }));
vi.mock('../lan/lan-manager', () => ({ getLanManager: () => ({ configure: vi.fn(), onEngineGone: env.gone, onVpnSuspend: vi.fn(), stopRoom: vi.fn(async () => {}), shutdown: env.shutdown }) }));
vi.mock('./ice-servers', () => ({ customTurnToIce: () => [], resolveTrackers: () => [] }));
vi.mock('../utils/os-notify', () => ({}));

import { RoomManager } from './room-manager';

function roomState(roomId = 'room-A'): RoomState {
  return {
    roomId, name: 'Room A', code: 'code', invite: 'invite', folder: 'D:/rooms/a', topicHash: 'hash', createdAt: 1,
    members: [{ memberId: 'A', name: 'Alice', online: true, isSelf: true }], files: [], transfers: {}, history: [], chat: [],
    connected: true, peerCount: 1, autoFetch: true, upKbps: 0, downKbps: 0,
    voice: { inVoice: false, muted: false, deafened: false, transmitting: false, inputMode: 'always', sharing: false, participants: [] },
    lan: { available: true, active: false, isHost: false, participants: [] },
  } as RoomState;
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function emit(win: any, channel: string, data?: unknown, sender = win.webContents, frame = sender.mainFrame) {
  env.listeners.get(channel)?.({ sender, senderFrame: frame }, data);
}
async function ready(win: any) { emit(win, 'room-ready'); await flush(); }
function commands(win: any) { return win.webContents.send.mock.calls.filter((c: any[]) => c[0] === 'room-cmd').map((c: any[]) => c[1]); }
function reply(win: any, type: string, data: unknown) {
  const command = commands(win).findLast((c: any) => c.type === type);
  expect(command).toBeTruthy(); emit(win, 'room-res', { reqId: command.reqId, ok: true, data });
}
let manager: RoomManager;
beforeEach(() => {
  vi.useFakeTimers(); env.windows = []; env.listeners.clear(); env.rooms = [];
  env.load = null; env.autoReady = false; env.autoReply = false; env.gone.mockClear();
  env.resourcePolicy = undefined; env.resourceError = '';
  env.commandError = ''; env.saveError = false; env.folders.clear(); env.captureAccess = null;
  env.partialSaveError = false; env.cleanupError = false; env.deleteError = false;
  env.fileError = ''; env.opened.mockClear(); env.revealed.mockClear();
  env.handlers.clear(); env.chat = []; env.edits = {}; env.draft = { text: '' }; env.committed.mockClear(); env.preferenceWrites.mockClear();
  env.removedEmpty.mockClear(); env.removedFiles.mockClear(); env.saved.mockClear(); env.deleted.mockClear();
  env.lastRead = 0; env.manifestBatch.mockClear(); env.historyBatch.mockClear();
  manager = new RoomManager();
});

describe('room setup transactions', () => {
  it('does not save a room before the engine confirms the join', async () => {
    const joining = manager.joinRoom('test-code'); await flush(); const win = env.windows[0];
    await ready(win); const command = commands(win).find((c: any) => c.type === 'join');
    expect(env.rooms).toHaveLength(0); expect(await manager.list()).toEqual([]);
    reply(win, 'join', { ...roomState(command.payload.roomId), code: 'test-code' });
    await joining; expect(env.rooms).toHaveLength(1);
  });

  it('rolls back a failed create without saving it or recursively deleting files', async () => {
    env.autoReady = true; env.autoReply = true; env.commandError = 'tracker unavailable';
    await expect(manager.createRoom('Room A')).rejects.toThrow('tracker unavailable');
    expect(env.rooms).toHaveLength(0); expect(env.removedEmpty).toHaveBeenCalledTimes(1);
    expect(commands(env.windows[0]).filter((c: any) => c.type === 'leave')).toHaveLength(1);
    expect(env.removedFiles.mock.calls.every((c: any[]) => !String(c[0]).includes('downloads'))).toBe(true);
  });

  it('coalesces concurrent creates and joins, but allows a later intentional create with the same name', async () => {
    env.autoReady = true; env.autoReply = true;
    const [a, b] = await Promise.all([manager.createRoom('Same'), manager.createRoom('Same')]);
    expect(a.roomId).toBe(b.roomId); expect(env.rooms).toHaveLength(1);
    await manager.createRoom('Same'); expect(env.rooms).toHaveLength(2);
    const [c, d] = await Promise.all([manager.joinRoom('test-code'), manager.joinRoom('  TEST CODE  ')]);
    expect(c.roomId).toBe(d.roomId); expect(env.rooms).toHaveLength(3);
  });

  it('stops an engine room if writing its confirmed state to storage fails', async () => {
    env.autoReady = true; env.autoReply = true; env.saveError = true;
    await expect(manager.createRoom('Room A')).rejects.toThrow('storage unavailable');
    expect(env.rooms).toHaveLength(0);
    expect(commands(env.windows[0]).some((c: any) => c.type === 'leave')).toBe(true);
  });

  it('removes a partially written record and preserves the original failure when cleanup also fails', async () => {
    env.autoReady = true; env.autoReply = true; env.partialSaveError = true; env.cleanupError = true;
    await expect(manager.createRoom('Room A')).rejects.toThrow('partial storage failure');
    expect(env.rooms).toHaveLength(0); expect(env.removedEmpty).toHaveBeenCalledOnce();
    expect(commands(env.windows[0]).some((c: any) => c.type === 'leave')).toBe(true);
  });

  it('does not resurrect a room when an old join response arrives after leave', async () => {
    const joining = manager.joinRoom('test-code').catch((e) => e); await flush(); const win = env.windows[0]; await ready(win);
    const command = commands(win).find((c: any) => c.type === 'join'), id = command.payload.roomId;
    const leaving = manager.leaveRoom(id); await flush(); reply(win, 'leave', { ok: true }); await leaving;
    reply(win, 'join', roomState(id)); expect((await joining).message).toMatch(/cancelled/);
    emit(win, 'room-update', roomState(id)); expect(await manager.getRoom(id)).toBeNull(); expect(env.rooms).toHaveLength(0);
  });

  it('does not create an engine for repeated leave of an unknown room', async () => {
    await Promise.all([manager.leaveRoom('missing'), manager.leaveRoom('missing')]);
    expect(env.windows).toHaveLength(0);
  });

  it('rejects a conflicting owner pin even when its code is already joined', async () => {
    await joinRoom(); env.rooms[0].ownerPin = 'a'.repeat(32);
    await expect(manager.joinRoom('code~' + 'b'.repeat(32))).rejects.toThrow(/owner|pin/i);
    expect(env.rooms[0].ownerPin).toBe('a'.repeat(32));
  });

  it('adds a compatible pin to an existing bare-code room without rejoining', async () => {
    await joinRoom(); env.rooms[0].ownerId = 'a'.repeat(32);
    await manager.joinRoom('code~' + 'a'.repeat(32));
    expect(env.rooms[0].ownerPin).toBe('a'.repeat(32));
    expect(commands(env.windows[0]).filter((c: any) => c.type === 'join')).toHaveLength(1);
    expect(commands(env.windows[0]).filter((c: any) => c.type === 'pinOwner')).toHaveLength(1);
  });

  it('accepts both root and current pins on the same saved chain and keeps the original anchor', async () => {
    await joinRoom();
    const root = 'a'.repeat(32), current = 'b'.repeat(32);
    Object.assign(env.rooms[0], { ownerId: current, ownerPin: root, transferChain: [{ by: root, newOwnerId: current, at: 1, pub: 'pub', sig: 'sig' }] });
    await manager.joinRoom('code~' + current); await manager.joinRoom('code~' + root);
    expect(env.rooms[0].ownerPin).toBe(root);
    expect(commands(env.windows[0]).filter((c: any) => c.type === 'join')).toHaveLength(1);
  });

  it('does not persist a new pin when the live engine rejects it', async () => {
    await joinRoom(); env.autoReply = false;
    const before = env.rooms[0].ownerPin;
    const result = manager.joinRoom('code~' + 'b'.repeat(32)).catch(error => error); await flush();
    const command = commands(env.windows[0]).findLast((c: any) => c.type === 'pinOwner');
    emit(env.windows[0], 'room-res', { reqId: command.reqId, ok: false, error: 'The verified owner chain conflicts with this pin' });
    expect((await result).message).toContain('conflicts');
    expect(env.rooms[0].ownerPin).toBe(before);
  });

  it('waits for concurrent joins before checking a root/current pin against their common chain', async () => {
    await joinRoom();
    const root = 'a'.repeat(32), current = 'b'.repeat(32);
    Object.assign(env.rooms[0], { ownerId: current, ownerPin: root, transferChain: [{ by: root, newOwnerId: current, at: 1, pub: 'pub', sig: 'sig' }] });
    const [a, b] = await Promise.all([manager.joinRoom('code~' + root), manager.joinRoom('code~' + current)]);
    expect(a.roomId).toBe(b.roomId); expect(env.rooms[0].ownerPin).toBe(root);
    await expect(manager.joinRoom('code~' + 'c'.repeat(32))).rejects.toThrow('conflicts');
    expect(env.rooms[0].ownerPin).toBe(root);
  });

  it('rejects a malformed pin before creating an engine or saving a room', async () => {
    await expect(manager.joinRoom('code~invalid')).rejects.toThrow('Invalid');
    expect(env.windows).toHaveLength(0); expect(env.rooms).toHaveLength(0);
  });

  it('retains an owner learned during setup, but publishes state only after commit', async () => {
    const update = vi.fn(); manager.onRoomUpdate(update);
    const joining = manager.joinRoom('test-code'); await flush(); const win = env.windows[0]; await ready(win);
    const id = commands(win).find((c: any) => c.type === 'join').payload.roomId;
    emit(win, 'room-owner', { roomId: id, ownerId: 'a'.repeat(32) });
    emit(win, 'room-update', roomState(id));
    expect(env.rooms).toHaveLength(0); expect(update).not.toHaveBeenCalled();
    reply(win, 'join', roomState(id)); await joining;
    expect(env.rooms[0].ownerId).toBe('a'.repeat(32)); expect(update).toHaveBeenCalledOnce();
  });

  it('coalesces leave and retains a concurrent request to delete downloaded files', async () => {
    await joinRoom(); env.autoReply = false;
    const first = manager.leaveRoom('room-A'), second = manager.leaveRoom('room-A', true);
    await flush(); const win = env.windows[0];
    expect(commands(win).filter((c: any) => c.type === 'leave')).toHaveLength(1);
    expect(env.rooms).toHaveLength(1);
    reply(win, 'leave', { ok: true }); await Promise.all([first, second]);
    expect(env.rooms).toHaveLength(0); expect(env.removedFiles).toHaveBeenCalledWith('D:/rooms/a', { recursive: true, force: true });
  });

  it('terminates an unresponsive engine before deleting the local room record', async () => {
    await joinRoom(); env.autoReply = false;
    const left = manager.leaveRoom('room-A'); await flush();
    expect(env.deleted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8000); await left;
    expect(env.windows[0].isDestroyed()).toBe(true); expect(env.rooms).toHaveLength(0);
  });

  it('clears live voice and capture permission even if saving the leave fails', async () => {
    await joinRoom(); const win = env.windows[0];
    const live = roomState(); live.voice.inVoice = true; emit(win, 'room-update', live);
    expect(env.captureAccess?.().audio).toBe(true);
    env.deleteError = true; const update = vi.fn(); manager.onRoomUpdate(update);
    await expect(manager.leaveRoom('room-A')).rejects.toThrow('delete failed');
    expect(env.captureAccess?.().audio).toBe(false);
    expect(update.mock.calls.at(-1)[0].voice.inVoice).toBe(false);
  });
});
afterEach(() => { manager.destroy(); vi.useRealTimers(); });

describe('engine lifecycle', () => {
  it('rejects all callers when the preload crashes before readiness', async () => {
    const first = manager.voiceDevices().catch((e) => e), second = manager.voiceMute('room-A', true).catch((e) => e);
    const win = env.windows[0];
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect((await first).message).toMatch(/crashed/);
    expect((await second).message).toMatch(/crashed/);
    expect(manager.getEngineStatus().state).toBe('failed');
    expect(win.isDestroyed()).toBe(true); expect(vi.getTimerCount()).toBe(1);
  });

  it('bounds startup even when page loading never finishes', async () => {
    env.load = () => new Promise(() => {});
    const pending = manager.voiceDevices().catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).message).toMatch(/20 seconds/);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('requires both the page load and the trusted ready handshake', async () => {
    const pending = manager.voiceDevices().catch((e) => e); const win = env.windows[0];
    emit(win, 'room-ready', undefined, { mainFrame: {} }); await flush();
    expect(commands(win)).toHaveLength(0);
    emit(win, 'room-ready', undefined, win.webContents, {}); await flush();
    expect(commands(win)).toHaveLength(0);
    await ready(win); reply(win, 'voiceDevices', []);
    expect(await pending).toEqual([]); expect(vi.getTimerCount()).toBe(1);
  });

  it('can retry after a preload error and ignores messages/events from the old engine', async () => {
    const failed = manager.voiceDevices().catch((e) => e); const old = env.windows[0];
    old.webContents.emit('preload-error', {}, 'preload.js', new Error('missing import'));
    expect((await failed).message).toMatch(/preload/);
    const pending = manager.voiceDevices(); const current = env.windows[1];
    emit(old, 'room-ready'); old.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); await flush();
    expect(manager.getEngineStatus().state).toBe('starting'); expect(current.isDestroyed()).toBe(false);
    await ready(current);
    const reqId = commands(current).find((c: any) => c.type === 'voiceDevices').reqId;
    emit(old, 'room-res', { reqId, ok: true, data: ['forged'] });
    reply(current, 'voiceDevices', []); expect(await pending).toEqual([]);
  });

  it('reports a failed page load instead of opening an insecure fallback', async () => {
    env.load = async () => { throw new Error('file unavailable'); };
    await expect(manager.voiceDevices()).rejects.toThrow('page failed to load');
    expect(manager.getEngineStatus().state).toBe('failed'); expect(vi.getTimerCount()).toBe(1);
  });

  it('rejects startup on application shutdown without scheduling a restart', async () => {
    const pending = manager.voiceDevices().catch((e) => e);
    manager.destroy(); expect((await pending).message).toMatch(/Shutting down/);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(manager.voiceDevices()).rejects.toThrow('shut down');
    expect(env.windows).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('engine commands', () => {
  it('does not reopen an engine when cleanup runs after a crash', async () => {
    await Promise.all([manager.voiceLeave('room-A'), manager.voiceMicTestStop(), manager.screenShareStop('room-A'), manager.screenWatchStop('room-A', 'B')]);
    expect(env.windows).toHaveLength(0);
  });

  it('does not restart the engine or request microphone access for an idle reconnect', async () => {
    await expect(manager.voiceReconnect('room-A')).rejects.toThrow(/not active/);
    expect(env.windows).toHaveLength(0); expect(env.captureAccess).toBeNull();
  });

  it('routes reconnect only to the running call and rejects it under the VPN kill-switch', async () => {
    env.autoReady = true; env.autoReply = true; await manager.voiceDevices(); const win = env.windows[0];
    env.rooms = [{ roomId: 'room-A', code: 'code' }];
    const state = roomState(); state.voice.inVoice = true; emit(win, 'room-update', state);
    await manager.voiceReconnect('room-A');
    expect(commands(win).filter((c: any) => c.type === 'voiceReconnect')).toHaveLength(1);
    await manager.suspendNetworking();
    await expect(manager.voiceReconnect('room-A')).rejects.toThrow(/VPN/);
    expect(commands(win).filter((c: any) => c.type === 'voiceReconnect')).toHaveLength(1);
  });

  it('cancels voice join while the main process is still preparing access', async () => {
    const join = manager.voiceJoin('room-A'); await manager.voiceLeave('room-A'); await join;
    expect(env.windows).toHaveLength(0);
  });

  it('only finishes the most recent voice join when switching rooms during preparation', async () => {
    env.autoReady = true; env.autoReply = true;
    await Promise.all([manager.voiceJoin('room-A'), manager.voiceJoin('room-B')]);
    expect(commands(env.windows[0]).filter((c: any) => c.type === 'voiceJoin').map((c: any) => c.roomId)).toEqual(['room-B']);
  });

  it('times out controls without retaining a pending request or response timer', async () => {
    const pending = manager.voiceMute('room-A', true).catch((e) => e), win = env.windows[0];
    await ready(win); await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).message).toMatch(/voiceMute/);
    reply(win, 'voiceMute', { ok: true }); expect(vi.getTimerCount()).toBe(1);
  });

  it('cancels a microphone join whose permission request outlives the command', async () => {
    const pending = manager.voiceJoin('room-A').catch((e) => e); await flush(); const win = env.windows[0];
    await ready(win); await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).message).toMatch(/voiceJoin/);
    expect(commands(win).map((c: any) => c.type)).toEqual(['voiceJoin', 'voiceLeave']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not let the timeout of an older voice join stop a newer one', async () => {
    const old = manager.voiceJoin('room-A').catch((e) => e); await flush(); const win = env.windows[0]; await ready(win);
    await vi.advanceTimersByTimeAsync(1000);
    const left = manager.voiceLeave('room-A'); await flush(); reply(win, 'voiceLeave', { ok: true }); await left;
    const current = manager.voiceJoin('room-A'); await flush();
    reply(win, 'voiceJoin', { ok: true }); await current;
    await vi.advanceTimersByTimeAsync(14000); expect((await old).message).toMatch(/voiceJoin/);
    expect(commands(win).filter((c: any) => c.type === 'voiceLeave')).toHaveLength(1);
  });

  it('revokes a mic test and cancels its command while the engine is starting', async () => {
    const test = manager.voiceMicTestStart({} as any).catch((e) => e); await flush(); const win = env.windows[0];
    expect(env.captureAccess?.().audio).toBe(true);
    const stop = manager.voiceMicTestStop(); await ready(win); reply(win, 'voiceMicTestStop', { ok: true }); await stop;
    expect((await test).message).toMatch(/cancelled/);
    expect(env.captureAccess?.()).toEqual({ audio: false, video: false });
    expect(commands(win).some((c: any) => c.type === 'voiceMicTestStart')).toBe(false);
  });

  it('cleans a failed synchronous IPC send immediately', async () => {
    const pending = manager.voiceDevices().catch((e) => e); const win = env.windows[0];
    win.webContents.send.mockImplementation(() => { throw new Error('IPC gone'); });
    await ready(win); expect((await pending).message).toBe('IPC gone'); expect(vi.getTimerCount()).toBe(1);
  });
});

async function joinRoom() {
  env.rooms = [{ roomId: 'room-A', name: 'Room A', code: 'code', folder: 'D:/rooms/a', createdAt: 1 }];
  env.autoReady = true; env.autoReply = true;
  return manager.getRoom('room-A');
}

describe('chat and settings acknowledgments', () => {
  const messageId = 'a'.repeat(32);
  it('waits for the chat acknowledgment and preserves the caller ID across retries', async () => {
    await joinRoom(); env.autoReply = false; const win = env.windows[0];
    let settled = false;
    const sent = manager.sendChat('room-A', 'hello', 'parent', messageId).then(value => { settled = true; return value; });
    await flush(); expect(settled).toBe(false);
    expect(commands(win).findLast((c: any) => c.type === 'chat').payload).toEqual({ id: messageId, text: 'hello', replyTo: 'parent' });
    reply(win, 'chat', { ok: true, id: messageId, state: 'saved-locally' });
    await expect(sent).resolves.toEqual({ ok: true, id: messageId, state: 'saved-locally' });
    const failed = manager.sendChat('room-A', 'hello', 'parent', messageId).catch(e => e); await flush();
    const command = commands(win).findLast((c: any) => c.type === 'chat');
    emit(win, 'room-res', { reqId: command.reqId, ok: false, error: 'disk full' });
    expect((await failed).message).toBe('disk full');
  });

  it('returns errors for missing rooms, a failed cached-engine restart, and a lost response', async () => {
    await expect(manager.sendChat('missing', 'hello')).rejects.toThrow('Room not found'); expect(env.windows).toHaveLength(0);
    await joinRoom(); env.autoReply = false;
    const pending = manager.sendChat('room-A', 'hello', undefined, messageId).catch(e => e); await flush();
    await vi.advanceTimersByTimeAsync(10000); expect((await pending).message).toMatch(/did not respond/);
    (manager as any).win = null; (manager as any).ready = false;
    vi.spyOn(manager as any, 'reactivate').mockRejectedValueOnce(new Error('restart failed'));
    await expect(manager.sendChat('room-A', 'hello')).rejects.toThrow('restart failed');
  });

  it('accepts durable writes only from the current engine main frame for a joined room', async () => {
    await joinRoom(); const win = env.windows[0], handler = env.handlers.get('room-persist-chat')!;
    const message = { id: messageId, memberId: 'A', text: 'hello', at: 1, pub: 'pub', sig: 'sig' };
    const payload = { roomId: 'room-A', message }, event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    expect(() => handler({ ...event, senderFrame: {} }, payload)).toThrow(/active engine/);
    expect(() => handler({ ...event, sender: {} }, payload)).toThrow(/active engine/);
    expect(() => handler(event, { ...payload, roomId: 'unknown' })).toThrow(/active engine/);
    expect(() => handler(event, { ...payload, message: { ...message, memberId: 'B' } })).toThrow(/Invalid/);
    expect(env.committed).not.toHaveBeenCalled();
    env.saveError = true; expect(() => handler(event, payload)).toThrow('storage unavailable'); expect(env.chat).toEqual([]);
    env.saveError = false; expect(handler(event, payload)).toEqual({ duplicate: false, message });
    expect(env.committed).toHaveBeenCalledOnce();
  });

  it('persists own edits before acknowledging them and reuses a stored identical edit', async () => {
    await joinRoom(); const win = env.windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    env.chat = [{ id: messageId, memberId: 'A', text: 'original', at: 1 }];
    const handler = env.handlers.get('room-persist-chat-edit')!, edit = { text: 'edited', at: 2, by: 'A', pub: 'pub', sig: 'sig' };
    env.saveError = true; expect(() => handler(event, { roomId: 'room-A', msgId: messageId, edit })).toThrow('storage unavailable');
    expect(env.edits).toEqual({}); env.saveError = false;
    expect(handler(event, { roomId: 'room-A', msgId: messageId, edit })).toEqual(edit);
    expect(handler(event, { roomId: 'room-A', msgId: messageId, edit: { ...edit, at: 5 } })).toEqual(edit);
    expect(() => handler(event, { roomId: 'room-A', msgId: messageId, edit: { ...edit, text: 'other', at: 1 } })).toThrow(/stale/);
    env.chat[0].memberId = 'B'; expect(() => handler(event, { roomId: 'room-A', msgId: messageId, edit })).toThrow(/Invalid/);
  });

  it('reports saved-but-not-applied without spawning an offline engine', async () => {
    env.rooms = [{ roomId: 'room-A', createdAt: 1 }];
    await expect(manager.setLimits('room-A', 64, 128)).resolves.toMatchObject({ saved: true, applied: false });
    expect(env.preferenceWrites).toHaveBeenCalledWith('setRoomLimits', 'room-A', 64, 128);
    expect(env.windows).toHaveLength(0);
    await expect(manager.setLimits('missing', 1, 1)).rejects.toThrow('Room not available');
    await expect(manager.setLimits('room-A', Infinity, 1)).rejects.toThrow('Invalid');
  });

  it('rejects a preference disk failure before issuing a live command', async () => {
    await joinRoom(); const win = env.windows[0]; env.saveError = true;
    await expect(manager.setAutoFetch('room-A', false)).rejects.toThrow('storage unavailable');
    expect(commands(win).some((c: any) => c.type === 'setAutoFetch')).toBe(false);
    expect((await manager.getRoom('room-A'))!.autoFetch).toBe(true);
  });

  it('waits for acknowledged actual state; timeout retains saved preference and cached values', async () => {
    await joinRoom(); env.autoReply = false; const win = env.windows[0];
    const changing = manager.setLimits('room-A', 64, 128); await flush();
    expect((await manager.getRoom('room-A'))!.upKbps).toBe(0);
    reply(win, 'setLimits', { ...roomState(), upKbps: 64, downKbps: 128 });
    await expect(changing).resolves.toMatchObject({ saved: true, applied: true, state: { upKbps: 64, downKbps: 128 } });
    const timedOut = manager.setLimits('room-A', 999, 999); await flush(); await vi.advanceTimersByTimeAsync(8000);
    await expect(timedOut).resolves.toMatchObject({ saved: true, applied: false, state: { upKbps: 64, downKbps: 128 }, error: expect.stringMatching(/did not respond/) });
    expect((await manager.getRoom('room-A'))!.upKbps).toBe(64);
  });

  it('serializes rapid settings changes and cancels queued changes after leaving', async () => {
    await joinRoom(); env.autoReply = false; const win = env.windows[0];
    const first = manager.setAutoFetch('room-A', false), second = manager.setLimits('room-A', 5, 6).catch(e => e);
    await flush(); expect(env.preferenceWrites).toHaveBeenCalledTimes(1);
    expect(commands(win).some((c: any) => c.type === 'setLimits')).toBe(false);
    const leaving = manager.leaveRoom('room-A'); await flush(); reply(win, 'leave', { ok: true }); await leaving;
    reply(win, 'setAutoFetch', { ...roomState(), autoFetch: false });
    expect((await first).applied).toBe(false); expect((await second).message).toMatch(/not available/);
    expect(env.preferenceWrites).toHaveBeenCalledTimes(1);
  });

  it('restores drafts without an engine and rejects draft writes after leaving', async () => {
    env.rooms = [{ roomId: 'room-A', createdAt: 1 }];
    await manager.saveChatDraft('room-A', { text: 'draft' }); expect(await manager.chatDraft('room-A')).toEqual({ text: 'draft' });
    expect(env.windows).toHaveLength(0); env.saveError = true;
    await expect(manager.saveChatDraft('room-A', { text: '' })).rejects.toThrow('storage unavailable');
    env.saveError = false; await manager.leaveRoom('room-A');
    await expect(manager.saveChatDraft('room-A', { text: 'late' })).rejects.toThrow('Room not found');
  });
});
describe('verified room file consumers', () => {
  it('waits for the engine to accept cached decryption and surfaces a rejection', async () => {
    await joinRoom(); const win = env.windows[0]; env.autoReply = false;
    let settled = false;
    const accepted = manager.retryDecrypt('room-A', 'file').then(value => { settled = true; return value; });
    await flush(); expect(settled).toBe(false);
    expect(commands(win).findLast((c: any) => c.type === 'retryDecrypt')).toMatchObject({ roomId: 'room-A', fileId: 'file' });
    reply(win, 'retryDecrypt', { ok: true }); await expect(accepted).resolves.toEqual({ ok: true });
    const rejected = manager.retryDecrypt('room-A', 'missing'); await flush();
    const req = commands(win).findLast((c: any) => c.type === 'retryDecrypt');
    emit(win, 'room-res', { reqId: req.reqId, ok: false, error: 'Download the encrypted file first' });
    await expect(rejected).rejects.toThrow('Download the encrypted file first');
    expect(commands(win).some((c: any) => c.type === 'fetchFile')).toBe(false);
  });
  async function withFile() {
    const state = (await joinRoom())!;
    state.files.push({ fileId: 'file', infoHash: 'file', name: 'film.mkv', size: 1, magnetURI: 'magnet', addedBy: 'B', addedByName: 'B', addedAt: 1 });
    state.transfers.file = { fileId: 'file', progress: 1, status: 'seeding', downSpeed: 0, peers: 0, haveLocally: true,
      localPath: env.verifiedPath, localStamp: 'verified-stamp' };
    return state;
  }
  it('opens only the engine-verified path after releasing the store and checking again', async () => {
    await withFile(); await manager.openFile('room-A', 'file');
    expect(commands(env.windows[0]).filter((c: any) => ['verifiedFile', 'releaseFile'].includes(c.type)).map((c: any) => c.type))
      .toEqual(['verifiedFile', 'releaseFile', 'verifiedFile']);
    expect(env.opened).toHaveBeenCalledWith(env.verifiedPath);
  });
  it('does not open a same-name flat file when the engine refuses verification', async () => {
    await withFile(); env.folders.add('D:/rooms/a/film.mkv'); env.fileError = 'file has changed';
    await expect(manager.openFile('room-A', 'file')).rejects.toThrow('file has changed');
    expect(env.opened).not.toHaveBeenCalled();
    expect(commands(env.windows[0]).some((c: any) => c.type === 'releaseFile')).toBe(false);
  });
  it('offers game-server content only while its verified filesystem identity still matches', async () => {
    const state = await withFile(); env.folders.add('D:/rooms/a/film.mkv');
    expect(manager.listRoomContentFiles('room-A')[0].localPath).toBeUndefined();
    env.folders.add(env.verifiedPath);
    expect(manager.listRoomContentFiles('room-A')[0].localPath).toBe(env.verifiedPath);
    state.transfers.file.haveLocally = false;
    expect(manager.listRoomContentFiles('room-A')[0].localPath).toBeUndefined();
  });
});
describe('room recovery', () => {
  it('coalesces concurrent restore/detail requests into one join', async () => {
    const first = joinRoom(); const restore = manager.restoreAll(); const second = manager.getRoom('room-A');
    await Promise.all([first, restore, second]);
    expect(env.windows).toHaveLength(1);
    expect(commands(env.windows[0]).filter((c: any) => c.type === 'join')).toHaveLength(1);
  });

  it('clears live state on crash and restores rooms without microphone, screen or LAN capture', async () => {
    await joinRoom(); const old = env.windows[0], main = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    manager.setMainWindow(main as any);
    const live = roomState(); live.voice.inVoice = true; live.voice.transmitting = true; live.voice.sharing = true; live.lan.active = true;
    emit(old, 'room-update', live);
    const hook = vi.fn(); manager.onRoomUpdate(hook);
    old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    const offline = hook.mock.calls[0][0];
    expect(offline.voice).toMatchObject({ inVoice: false, transmitting: false, sharing: false, participants: [] });
    expect(offline.lan.active).toBe(false); expect(offline.members[0].online).toBe(false);
    expect((await manager.list())[0].onlineCount).toBe(0);
    expect(env.gone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.windows).toHaveLength(2);
    expect((await manager.getRoom('room-A'))!.voice.inVoice).toBe(false);
    expect(commands(env.windows[1]).map((c: any) => c.type)).toEqual(['resourceSettings', 'join']);
    expect(manager.getEngineStatus().state).toBe('ready');
    emit(old, 'room-update', live); old.emit('closed');
    expect((await manager.getRoom('room-A'))!.voice.inVoice).toBe(false);
  });

  it('cancels crash recovery while the VPN kill-switch is active', async () => {
    await joinRoom(); env.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await manager.suspendNetworking(); await vi.advanceTimersByTimeAsync(60_000);
    expect(env.windows).toHaveLength(1);
    await expect(manager.getRoom('room-A')).rejects.toThrow('VPN');
    await manager.resumeNetworking(); expect(env.windows).toHaveLength(2);
    expect((await manager.list())[0].suspended).toBe(false);
  });

  it('closes an engine that does not acknowledge the VPN safety pause', async () => {
    await joinRoom(); env.autoReply = false;
    const paused = manager.suspendNetworking(); await flush();
    await vi.advanceTimersByTimeAsync(8000); await paused;
    expect(env.windows[0].isDestroyed()).toBe(true);
    expect(manager.getEngineStatus().state).toBe('failed');
    expect(env.captureAccess?.()).toEqual({ audio: false, video: false });
    await vi.advanceTimersByTimeAsync(60000); expect(env.windows).toHaveLength(1);
  });

  it('stops automatic recovery after three failed attempts', async () => {
    await joinRoom(); env.autoReady = false;
    env.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    for (const delay of [1_000, 3_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      env.windows.at(-1).webContents.emit('preload-error', {}, '', new Error('missing'));
      await flush();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.windows).toHaveLength(4); expect(manager.getEngineStatus().state).toBe('failed');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('returns null only for an unknown room, and propagates actual connection errors', async () => {
    expect(await manager.getRoom('unknown')).toBeNull();
    env.rooms = [{ roomId: 'room-A' }]; env.load = async () => { throw new Error('unavailable'); };
    await expect(manager.getRoom('room-A')).rejects.toThrow('page failed to load');
  });
});


describe('chat unread uses the local receipt clock', () => {
  it('does not leave future sender timestamps unread after viewing and counts delayed arrivals', async () => {
    env.rooms = [{ roomId: 'room-A', name: 'Room A', folder: 'D:/rooms/a', code: 'code' }];
    env.lastRead = 100;
    env.chat = [
      { id: 'future', memberId: 'B', at: 9999999999999, receivedAt: 90 },
      { id: 'delayed', memberId: 'B', at: 1, receivedAt: 110 },
      { id: 'own', memberId: 'A', at: 1, receivedAt: 110 },
    ];
    expect((await manager.list())[0].unread).toBe(1);
    env.lastRead = 120;
    expect((await manager.list())[0].unread).toBe(0);
  });
});


describe('room secret storage recovery', () => {
  it('shows a locked room without spawning its engine, and retries after OS access is restored', async () => {
    env.rooms = [{ roomId: 'room-A', name: 'Room A', code: '', folder: 'D:/rooms/a', createdAt: 1, storageError: 'decrypt-failed' }];
    expect((await manager.list())[0]).toMatchObject({ roomId: 'room-A', code: '', storageError: 'decrypt-failed' });
    await expect(manager.getRoom('room-A')).rejects.toThrow('rooms.storage.decrypt-failed'); expect(env.windows).toEqual([]);
    env.rooms[0] = { ...env.rooms[0], code: 'code', storageError: undefined }; env.autoReady = true; env.autoReply = true;
    expect((await manager.getRoom('room-A'))?.code).toBe('code');
  });
  it('retains the complete live key update on save failure and persists it on an explicit retry', async () => {
    await joinRoom(); const win = env.windows[0]; env.saveError = true;
    emit(win, 'room-rekey', { roomId: 'room-A', code: 'new-code' });
    const previous = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, '0'));
    const pages = [{ page: 0, sig: 'signed-proof' }];
    emit(win, 'room-e2e', { roomId: 'room-A', e2e: true, secret: 'new-secret', prevSecrets: previous, keyPages: pages, cfg: { sig: 'cfg' } });
    expect(env.rooms[0].code).toBe('code'); expect((await manager.list())[0].storageError).toBe('write-failed');
    await expect(manager.getRoom('room-A')).rejects.toThrow(/storage/);
    env.saveError = false; await manager.getRoom('room-A');
    expect(env.rooms[0]).toMatchObject({ code: 'new-code', secret: 'new-secret', prevSecrets: previous, keyPages: pages });
    expect((await manager.list())[0].storageError).toBeUndefined();
  });
});

describe('signed room ban persistence', () => {
  it('accepts updates only from the current engine and carries the proof into a restored join', async () => {
    await joinRoom(); const win = env.windows[0], proof = { v: 1, ownerId: 'owner', revision: 1, bans: ['removed'], pub: 'pub', sig: 'proof' };
    emit(win, 'room-bans', { roomId: 'room-A', bans: ['removed'], banState: proof }, { mainFrame: {} });
    expect(env.rooms[0].banState).toBeUndefined();
    emit(win, 'room-bans', { roomId: 'room-A', bans: ['removed'], banState: proof });
    expect(env.rooms[0]).toMatchObject({ bans: ['removed'], banState: proof });
    win.destroy(); env.autoReady = true; env.autoReply = true; await manager.getRoom('room-A');
    expect(commands(env.windows.at(-1)).find(c => c.type === 'join').payload).toMatchObject({ bans: ['removed'], banState: proof });
  });
  it('preserves the full ban proof with a failed live write and retries it without losing older bans', async () => {
    await joinRoom(); const win = env.windows[0]; env.saveError = true;
    const proof = { v: 1, ownerId: 'owner', revision: 2, bans: ['first', 'second'], pub: 'pub', sig: 'proof' };
    emit(win, 'room-bans', { roomId: 'room-A', bans: proof.bans, banState: proof });
    expect(env.rooms[0].banState).toBeUndefined(); expect((await manager.list())[0].storageError).toBe('write-failed');
    env.saveError = false; await manager.getRoom('room-A'); expect(env.rooms[0].banState).toEqual(proof);
  });
});


describe('room resource preferences', () => {
  it('saves without opening an engine and applies before the first join', async () => {
    const policy = { ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 128, screenBitrateKbps: 1000 };
    expect(await manager.setResources(policy)).toMatchObject({ saved: true, applied: false, policy });
    expect(env.windows).toHaveLength(0);
    env.autoReady = true; env.autoReply = true; await manager.createRoom('manual');
    const messages = commands(env.windows[0]);
    expect(messages.find((c: any) => c.type === 'resourceSettings').policy).toEqual(policy);
    expect(messages.find((c: any) => c.type === 'join').payload).toMatchObject({ resources: policy, autoFetch: false });
    expect(env.rooms[0].autoFetch).toBe(false);
  });
  it('distinguishes saved preferences from a live application failure', async () => {
    env.autoReady = true; env.autoReply = true; await manager.createRoom('active');
    env.resourceError = 'limiter failed';
    const policy = { ...DEFAULT_ROOM_RESOURCES, maxUpKbps: 123 };
    expect(await manager.setResources(policy)).toMatchObject({ saved: true, applied: false, policy, error: 'limiter failed' });
    expect(env.resourcePolicy).toEqual(policy);
    env.resourceError = '';
    expect(await manager.setResources(policy)).toMatchObject({ saved: true, applied: true });
  });
  it('does not change the live engine if persistence fails', async () => {
    env.autoReady = true; env.autoReply = true; await manager.createRoom('active');
    const before = commands(env.windows[0]).length; env.saveError = true;
    await expect(manager.setResources(DEFAULT_ROOM_RESOURCES)).rejects.toThrow('storage unavailable');
    expect(commands(env.windows[0])).toHaveLength(before);
  });
  it('persists explicit auto-fetch for new joins and preserves a legacy room on rejoin', async () => {
    env.autoReady = true; env.autoReply = true;
    await manager.joinRoom('new-code', true);
    expect(env.rooms[0].autoFetch).toBe(true);
    expect(commands(env.windows[0]).findLast((c: any) => c.type === 'join').payload.autoFetch).toBe(true);
    delete env.rooms[0].autoFetch;
    await manager.joinRoom('new-code', false);
    expect(env.rooms[0].autoFetch).toBeUndefined();
  });
});

describe('room diagnostics and discovery retry', () => {
  it('reads a saved offline room without starting an engine or enabling capture', () => {
    env.rooms = [{ roomId: 'room-A', name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', folder: 'PRIVATE_FOLDER' }];
    const report = manager.diagnoseRoom('room-A');
    expect(report.connection.phase).toBe('offline'); expect(report.appVersion).toBe('3.0.7');
    expect(JSON.stringify(report)).not.toContain('PRIVATE'); expect(env.windows).toHaveLength(0);
    expect(env.captureAccess).toBeNull(); expect(() => manager.diagnoseRoom('unknown')).toThrow('Room not available');
  });
  it('retains safe success observations across a crash without restarting on inspection', async () => {
    await joinRoom(); const win = env.windows[0], state = roomState();
    const monitor = new RoomConnectionMonitor(2, () => 1000); monitor.identified(); monitor.synced();
    state.connection = monitor.snapshot({ pending: 0, open: 1, identified: 1, syncing: 0, direct: 1, turn: 0, unknown: 0 }, false, false);
    emit(win, 'room-update', state);
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    const report = manager.diagnoseRoom('room-A');
    expect(report.connection).toMatchObject({ phase: 'engine-failed', lastConnectedAt: 1000, lastSyncAt: 1000, channels: { open: 0 } });
    expect(env.windows).toHaveLength(1); expect(report.voice.joined).toBe(false);
  });
  it('permits inspection under the VPN kill-switch but blocks connection retry', async () => {
    await joinRoom(); await manager.suspendNetworking(); const win = env.windows[0], before = commands(win).length;
    expect(manager.diagnoseRoom('room-A').connection.phase).toBe('suspended');
    await expect(manager.retryConnection('room-A')).rejects.toThrow('VPN');
    expect(commands(win)).toHaveLength(before); expect(env.windows).toHaveLength(1);
  });
  it('coalesces retries and does not send voice, screen or LAN start commands', async () => {
    await joinRoom(); env.autoReply = false; const win = env.windows[0], before = commands(win).length;
    const a = manager.retryConnection('room-A'), b = manager.retryConnection('room-A');
    expect(a).toBe(b); await flush();
    expect(commands(win).slice(before).map(c => c.type)).toEqual(['retryConnection']);
    reply(win, 'retryConnection', roomState());
    expect((await a).engine.state).toBe('ready'); await b;
  });
  it('rejects a retry that completes after leaving and never publishes that late state', async () => {
    await joinRoom(); env.autoReply = false; const win = env.windows[0];
    const pending = manager.retryConnection('room-A').catch(error => error); await flush();
    const leaving = manager.leaveRoom('room-A'); await flush(); reply(win, 'leave', { ok: true }); await leaving;
    reply(win, 'retryConnection', roomState());
    expect((await pending).message).toMatch(/cancelled|Room not available/);
    expect(() => manager.diagnoseRoom('room-A')).toThrow('Room not available'); expect(await manager.list()).toEqual([]);
  });
  it('does not retry discovery for a removed room', async () => {
    await joinRoom(); const win = env.windows[0]; emit(win, 'room-update', { ...roomState(), kicked: true });
    const before = commands(win).length;
    await expect(manager.retryConnection('room-A')).rejects.toThrow('removed');
    expect(commands(win)).toHaveLength(before); expect(manager.diagnoseRoom('room-A').connection.phase).toBe('removed');
  });
});


describe('manifest page IPC authority', () => {
  it('persists a bounded page once and rejects oversized pages, other windows and subframes', async () => {
    await joinRoom(); const win = env.windows[0], files = [{ fileId: 'f' }];
    emit(win, 'room-manifest-batch', { roomId: 'room-A', files });
    expect(env.manifestBatch).toHaveBeenCalledExactlyOnceWith('room-A', files);
    emit(win, 'room-manifest-batch', { roomId: 'room-A', files: Array.from({ length: 65 }, () => files[0]) });
    emit(win, 'room-manifest-batch', { roomId: 'room-A', files }, win.webContents, {});
    emit(win, 'room-manifest-batch', { roomId: 'room-A', files }, {});
    emit(win, 'room-manifest-batch', { roomId: 'missing', files });
    expect(env.manifestBatch).toHaveBeenCalledTimes(1);
  });
});

describe('watch host acknowledgement', () => {
  it('waits for the engine decision and surfaces owner/host errors', async () => {
    await joinRoom(); const win = env.windows[0]; env.autoReply = false;
    let settled = false; const change = manager.setWatchHost('room-A', 'B').then(value => { settled = true; return value; });
    await flush(); expect(settled).toBe(false);
    expect(commands(win).findLast((c: any) => c.type === 'watchPolicy')).toMatchObject({ roomId: 'room-A', hostId: 'B' });
    const state = { ...roomState('room-A'), watchPolicy: { t: 'watch-policy-v1', by: 'A', hostId: 'B', at: 1, pub: 'pub', sig: 'sig' } };
    reply(win, 'watchPolicy', state); await expect(change).resolves.toEqual(state);
    const denied = manager.setWatchHost('room-A', 'missing'); await flush();
    const req = commands(win).findLast((c: any) => c.type === 'watchPolicy');
    emit(win, 'room-res', { reqId: req.reqId, ok: false, error: 'Watch host is unavailable' });
    await expect(denied).rejects.toThrow('Watch host is unavailable');
  });
});


it('keeps only the history maintenance timer between commands and clears it on shutdown', async () => {
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(vi.getTimerCount()).toBe(1);expect(env.windows).toHaveLength(0);
  manager.destroy();expect(vi.getTimerCount()).toBe(0);
});

describe('room network lifecycle', () => {
  it('waits for linked servers before deleting a room and blocks starts during leave', async () => {
    await joinRoom(); let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); manager.onRoomUnavailable(stop);
    const leaving = manager.leaveRoom('room-A'); await flush();
    expect(stop).toHaveBeenCalledWith('room-A', 'left'); expect(manager.isRoomAvailable('room-A')).toBe(false);
    expect(env.deleted).not.toHaveBeenCalled(); finish(); await leaving; expect(env.deleted).toHaveBeenCalledWith('room-A');
  });
  it('preserves the room for retry if its process cannot confirm shutdown', async () => {
    await joinRoom(); manager.onRoomUnavailable(async () => { throw new Error('still running'); });
    await expect(manager.leaveRoom('room-A')).rejects.toThrow('still running');
    expect(env.rooms).toHaveLength(1); expect(env.deleted).not.toHaveBeenCalled();
  });
  it('cannot lift a VPN pause by waking up, or a sleep pause by restoring VPN', async () => {
    await joinRoom(); await manager.suspendNetworking('sleep'); await manager.suspendNetworking();
    await manager.resumeNetworking('sleep'); expect((await manager.list())[0].suspended).toBe(true);
    await expect(manager.retryConnection('room-A')).rejects.toThrow('VPN');
    await manager.resumeNetworking(); expect((await manager.list())[0].suspended).toBe(false);
    await manager.suspendNetworking('sleep'); await manager.suspendNetworking(); await manager.resumeNetworking();
    expect((await manager.list())[0].suspended).toBe(true); await manager.resumeNetworking('sleep');
    expect((await manager.list())[0].suspended).toBe(false);
  });
  it('serializes resume with an unfinished pause and does not restore LAN or capture', async () => {
    await joinRoom(); env.autoReply = false;
    const pause = manager.suspendNetworking('sleep'); const resume = manager.resumeNetworking('sleep'); await flush();
    const win = env.windows[0]; expect(commands(win).some((c: any) => c.type === 'netResume')).toBe(false);
    reply(win, 'netSuspend', { ok: true }); await pause; env.autoReply = true; await flush();
    reply(win, 'netResume', { ok: true }); await resume;
    expect((await manager.list())[0].suspended).toBe(false);
    expect(commands(win).filter((c: any) => ['lanStart', 'voiceJoin', 'screenShareStart'].includes(c.type))).toHaveLength(0);
  });
  it('stops linked servers on a kicked snapshot and on an engine crash', async () => {
    await joinRoom(); const stopped = vi.fn(async () => {}); manager.onRoomUnavailable(stopped);
    emit(env.windows[0], 'room-update', { ...roomState(), kicked: true }); await flush();
    expect(stopped).toHaveBeenCalledWith('room-A', 'removed'); expect(manager.isRoomAvailable('room-A')).toBe(false);
    env.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' }); await flush();
    expect(stopped).toHaveBeenCalledWith('room-A', 'engine-failed');
  });
  it('does not create an engine when stopping idle LAN and refuses a retry without an active session', async () => {
    await manager.lanStop('room-A'); expect(env.windows).toHaveLength(0);
    await joinRoom(); await expect(manager.lanRetry('room-A')).rejects.toThrow('not active');
  });
});

it('does not let a stale resume release a newer VPN pause of the same reason', async () => {
  await joinRoom(); env.autoReply = false;
  const firstPause = manager.suspendNetworking(); const staleResume = manager.resumeNetworking();
  const newPause = manager.suspendNetworking(); await flush(); reply(env.windows[0], 'netSuspend', { ok: true });
  await Promise.all([firstPause, staleResume, newPause]); expect((await manager.list())[0].suspended).toBe(true);
  expect(commands(env.windows[0]).some((c: any) => c.type === 'netResume')).toBe(false);
  env.autoReply = true; await manager.resumeNetworking(); expect((await manager.list())[0].suspended).toBe(false);
});

it('propagates explicit local-server leave mode, and a repeated leave cannot silently override it', async () => {
  await joinRoom(); let finish!: () => void;
  const detach = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); manager.onRoomUnavailable(detach);
  const first = manager.leaveRoom('room-A', false, 'local');
  const second = manager.leaveRoom('room-A', false, 'stop'); await flush();
  expect(detach).toHaveBeenCalledOnce(); expect(detach).toHaveBeenCalledWith('room-A', 'left-local');
  expect(env.deleted).not.toHaveBeenCalled(); finish(); await Promise.all([first, second]); expect(env.deleted).toHaveBeenCalledWith('room-A');
});

it('restricts privileged server stdin to the active engine main frame and an available room', async () => {
  await joinRoom(); const win = env.windows[0];
  expect(() => manager.assertEngineServerCommand({ sender: win.webContents, senderFrame: win.webContents.mainFrame } as any, 'room-A')).not.toThrow();
  expect(() => manager.assertEngineServerCommand({ sender: win.webContents, senderFrame: {} } as any, 'room-A')).toThrow();
  expect(() => manager.assertEngineServerCommand({ sender: {} as any, senderFrame: win.webContents.mainFrame } as any, 'room-A')).toThrow();
  expect(() => manager.assertEngineServerCommand({ sender: win.webContents, senderFrame: win.webContents.mainFrame } as any, 'other')).toThrow();
  await manager.suspendNetworking('sleep');
  expect(() => manager.assertEngineServerCommand({ sender: win.webContents, senderFrame: win.webContents.mainFrame } as any, 'room-A')).toThrow();
});
