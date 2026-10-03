import { PendingServerCommands } from '../../shared/server-command';
import { ROOM_FILE_LIMIT, ROOM_FOLDER_LIMIT, ROOM_FOLDER_TOMB_LIMIT } from '../../shared/room-manifest-sync';
import { ROOM_IDENTITY_LIMIT } from '../../shared/room-protocol';
/* eslint-disable @typescript-eslint/no-explicit-any -- Real preload functions run in a VM with small resource doubles. */
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOM_PROTOCOL_VERSION, DESKTOP_ROOM_CAPABILITIES } from '../../shared/room-capabilities';
import { assertCompatibleOwnerPin } from '../../shared/room-owner-pin';
import { ROOM_BAN_LIMIT } from '../../shared/room-bans';
import { mergeContentKeys, completeContentKeys } from './room-keyring';
import { retainRoomChat } from '../../shared/room-chat-history';
import { RoomConnectionMonitor } from '../../shared/room-diagnostics';

// Exercise the real preload functions without importing its hardware/network bootstrap.
const source = readFileSync(new URL('./room-engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(start: string, end: string): string {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing engine fixture boundary');
  return source.slice(a, b);
}
const start = extract('function startRoom(', '\n/** A locally-seeded file:');
const tracker = extract('function attachTracker(', '\nfunction restartTracker(');
const restart = extract('function restartTracker(', '\n// ── Kick');
const close = extract('const closingRooms =', '\n/**\n * Stop seeding a file');
const screen = extract("    else if (type === 'screenShareStart') {", "    else if (type === 'screenShareStop')")
  .slice("    else if (type === 'screenShareStart') {".length).replace(/}\s*$/, '');
const devices = extract('async function listVoiceDevices(', '\n}',).concat('\n}');

function fixture() {
  const rooms = new Map<string, any>(), clients = new Map<string, any>(), pendingScreenEpochs = new Map<string, number>();
  const suspend = vi.fn(), share = vi.fn(), stopped = vi.fn(), statePush = vi.fn();
  const trackers: any[] = [];
  const monitors = new WeakMap<object, RoomConnectionMonitor>();
  const connectionMonitor = (room: any) => {
    if (!monitors.has(room)) monitors.set(room, new RoomConnectionMonitor(room.trackers.length));
    return monitors.get(room)!;
  };
  let trackerFails = false;
  let resolveCapture!: (stream: unknown) => void;
  const context: any = {
    PendingServerCommands, ROOM_FILE_LIMIT, ROOM_FOLDER_LIMIT, ROOM_FOLDER_TOMB_LIMIT, ROOM_IDENTITY_LIMIT, resetHelloSync: vi.fn(), ROOM_BAN_LIMIT, mintBanState: vi.fn(), adoptBanState: vi.fn(), requestKeyPages: vi.fn(), mergeContentKeys, completeContentKeys, rooms, clients, pendingScreenEpochs, joinNetworkEpoch: 0, netSuspended: false,
    fs: { mkdirSync: vi.fn(), readdirSync: () => [] }, path: { join: (...parts: string[]) => parts.join('/') },
    setTimeout, clearTimeout, setInterval, clearInterval, Date,
    TrackerClient: class extends EventEmitter {
      stop = stopped; destroy = vi.fn();
      constructor() { super(); trackers.push(this); }
      start() { if (trackerFails) throw new Error('tracker start failed'); }
    },
    nativeWrtc: {}, STUN_SERVERS: [], RENDEZVOUS_TRACKERS: ['wss://fake'], PING_INTERVAL: 15000, OFFLINE_AFTER: 45000,
    MAX_PREV_SECRETS: 8, MAX_SECRET: 128, MAX_STR: 128,
    deriveKey: () => 'key', topicHash: () => 'topic', rendezvousId: () => 'rendezvous', randomPeerId: () => 'peer',
    codeIsE2E: () => false, clampStr: String, idMatchesPub: () => false,
    reactsFromRecord: () => new Map(), reactsFromRecordIn: () => new Map(), chatEditsFromRecord: () => new Map(),
    CHAT_REACTION_EMOJI: [], MAX_REACT_MSGS: 500,
    createVoiceSession: () => ({ suspend, onMemberGone: vi.fn(), isActive: () => true, startShare: share }),
    buildState: (r: any) => ({ roomId: r.roomId, members: [{ have: [] }] }), pushState: statePush,
    connectionMonitor, observeConnection: (r: any, event: any) => connectionMonitor(r).observe(event), sampleChannelPath: vi.fn(),
    removeFileClient: vi.fn(), refreshFileBudget: vi.fn(), pushResourceStates: vi.fn(), applyResourcePolicy: vi.fn(), receiveQueue: { cancelWaiting: vi.fn() }, cancelReceives: vi.fn(), teardownLan: vi.fn(), closeStreamServers: vi.fn(), broadcast: vi.fn(), attachWire: vi.fn(), log: vi.fn(),
    assertCompatibleOwnerPin, retainRoomChat, ROOM_PROTOCOL_VERSION, DESKTOP_ROOM_CAPABILITIES,
    cancelScreenCapture: (id: string) => pendingScreenEpochs.set(id, (pendingScreenEpochs.get(id) ?? 0) + 1),
    captureScreen: () => new Promise(resolve => { resolveCapture = resolve; }),
    navigator: { mediaDevices: { enumerateDevices: vi.fn(async () => [{ deviceId: 'one', kind: 'audioinput', label: '' }]), getUserMedia: vi.fn() } },
  };
  const js = ts.transpileModule(`${tracker}\n${restart}\n${close}\n${start}\n${devices}\nasync function screenStart(msg) {let data; ${screen}\nreturn data;}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, context);
  return {
    context, rooms, clients, trackers, suspend, share, statePush,
    failTracker: () => { trackerFails = true; }, resolveCapture: (stream: unknown) => resolveCapture(stream),
    start: (id = 'room') => context.startRoom({ roomId: id, name: id, code: 'code', folder: '/mock/room', self: { memberId: 'A' }, useTurn: false }),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('room engine setup and teardown', () => {
  it('propagates an initial tracker failure and closes partially created resources', async () => {
    const f = fixture(); f.failTracker();
    const destroy = vi.fn((done: () => void) => done()); f.clients.set('room', { destroy });
    expect(() => f.start()).toThrow('tracker start failed');
    await f.context.leaveRoom('room');
    expect(f.rooms.size).toBe(0); expect(f.clients.size).toBe(0);
    expect(f.suspend).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
    expect(f.trackers[0].destroy).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report leave complete before the client has released its stores', async () => {
    const f = fixture(); f.start();
    let finish!: () => void;
    f.clients.set('room', { destroy: (done: () => void) => { finish = done; } });
    let completed = false;
    const left = f.context.leaveRoom('room').then(() => { completed = true; });
    const repeated = f.context.leaveRoom('room');
    expect(f.rooms.size).toBe(0); expect(f.clients.size).toBe(0);
    await vi.advanceTimersByTimeAsync(200); expect(completed).toBe(false);
    finish(); await Promise.all([left, repeated]);
    expect(completed).toBe(true); expect(f.suspend).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not keep an old heartbeat when the same room is reopened', async () => {
    const f = fixture(); f.start();
    const left = f.context.leaveRoom('room'); await vi.advanceTimersByTimeAsync(200); await left;
    f.start(); f.statePush.mockClear(); await vi.advanceTimersByTimeAsync(15000);
    expect(f.statePush).toHaveBeenCalledOnce();
    const finalLeave = f.context.leaveRoom('room'); await vi.advanceTimersByTimeAsync(200); await finalLeave;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a folder-creation error before starting any room', () => {
    const f = fixture(); f.context.fs.mkdirSync.mockImplementation(() => { throw new Error('access denied'); });
    expect(() => f.start()).toThrow('access denied'); expect(f.rooms.size).toBe(0); expect(f.trackers).toHaveLength(0);
  });

  it('lists devices without opening the microphone to reveal labels', async () => {
    const f = fixture(); expect(await f.context.listVoiceDevices()).toHaveLength(1);
    expect(f.context.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it('propagates a discovery retry failure without destroying established peers', async () => {
    const f = fixture(); f.start(); const room = f.rooms.get('room'), peer = { destroy: vi.fn() };
    room.wires.set(1, { peer }); const old = f.trackers[0]; f.failTracker();
    expect(() => f.context.restartTracker(room, true)).toThrow('tracker start failed');
    expect(peer.destroy).not.toHaveBeenCalled(); expect(room.wires.size).toBe(1);
    const channels = { pending: 0, open: 1, identified: 1, syncing: 0, direct: 0, turn: 0, unknown: 1 };
    old.emit('error', new Error('stale tracker')); old.emit('update', { announce: 'wss://fake' });
    const after = f.context.connectionMonitor(room).snapshot(channels, false, false);
    expect(after.observations['tracker-unavailable']).toBe(1); expect(after.trackers.acknowledged).toBe(0);
    const left = f.context.leaveRoom('room'); await vi.advanceTimersByTimeAsync(200); await left;
  });
});

describe('late screen capture', () => {
  it.each(['stop', 'leave and reopen', 'suspend and resume'])('stops the returned stream after %s', async (action) => {
    const f = fixture(); f.start();
    const pending = f.context.screenStart({ roomId: 'room', sourceId: 'fake' }).catch((e: Error) => e);
    if (action === 'stop') f.context.cancelScreenCapture('room');
    if (action === 'leave and reopen') { const left = f.context.leaveRoom('room'); await vi.advanceTimersByTimeAsync(200); await left; f.start(); }
    if (action === 'suspend and resume') f.context.joinNetworkEpoch++;
    const stop = vi.fn(); f.resolveCapture({ getTracks: () => [{ stop }] });
    expect((await pending).message).toMatch(/cancelled|ended/);
    expect(stop).toHaveBeenCalledOnce(); expect(f.share).not.toHaveBeenCalled();
    const left = f.context.leaveRoom('room'); await vi.advanceTimersByTimeAsync(200); await left;
  });
});

describe('LAN helper connection lifecycle', () => {
  for (const change of ['stop', 'leave', 'rejoin', 'suspend']) it('rejects a helper connection completed after ' + change, async () => {
    const rooms = new Map<string, any>(); const room: any = { roomId: 'room' }; rooms.set('room', room);
    let connected!: () => void; const session = { setRelayEnabled: vi.fn(), startAsHost: vi.fn(), start: vi.fn(), suspend: vi.fn() };
    const client = { close: vi.fn(), connect: () => new Promise<void>(resolve => { connected = resolve; }) };
    const context: any = { rooms, netSuspended: false, lanRelayEnabled: true, log: vi.fn(),
      createLanSession: () => session, teardownLan: (r: any) => { r.lanPipe = null; }, pushState: vi.fn(),
      LanPipeClient: function () { return client; }, onLanControl: vi.fn() };
    vm.runInNewContext(ts.transpileModule(extract('async function lanStart(', '\n/** Capture a screen'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const started = context.lanStart('room', { isHost: true, sessionId: 'id', pipeName: 'pipe', token: 'token' }).catch((e: Error) => e);
    if (change === 'stop') room.lanPipe = null;
    if (change === 'leave') rooms.delete('room');
    if (change === 'rejoin') rooms.set('room', { roomId: 'room' });
    if (change === 'suspend') context.netSuspended = true;
    connected(); expect((await started).message).toMatch(/cancelled/);
    expect(client.close).toHaveBeenCalledOnce(); expect(session.startAsHost).not.toHaveBeenCalled(); expect(context.pushState).not.toHaveBeenCalled();
  });
});
