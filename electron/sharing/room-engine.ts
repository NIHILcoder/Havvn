/**
 * Room engine — runs as the PRELOAD of a hidden BrowserWindow (one per app),
 * exactly like share-seeder.ts, so it uses Chromium's native WebRTC (the native
 * @roamhq/wrtc module crashes under Electron on connect).
 *
 * It does three things for each joined room:
 *   1. Rendezvous: a bittorrent-tracker client announces the room's topicHash on
 *      the WSS trackers and hands us WebRTC wires (simple-peer) to other members.
 *   2. Gossip: over each wire we exchange AES-GCM-encrypted messages (key derived
 *      from the invite code) — HELLO/ADD/HAVE/PING — to converge an add-only file
 *      manifest and a live "who has what" / presence view. A wrong code fails the
 *      GCM auth tag, so it doubles as the membership check.
 *   3. Transfer: every manifest file is moved P2P over a normal WebTorrent swarm
 *      (its own infoHash) — local files are seeded from disk, remote files are
 *      auto-downloaded into the room folder. Same swarm infra as share links.
 *
 * Talks to the main process over ipcRenderer:
 *   main → here:  'room-cmd'    { type, reqId, ... }
 *   here → main:  'room-res'    { reqId, ok, data|error }
 *   here → main:  'room-update' RoomState           (pushed on change, throttled)
 *   here → main:  'room-log'    string
 */

import { ipcRenderer } from 'electron';
import fs from 'fs';
import path from 'path';
import WebTorrent from 'webtorrent';
import { deriveKey, topicHash, randomPeerId, encrypt, decrypt } from './room-crypto';
import { RoomFile, RoomMember, RoomState, RoomTransfer } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackerClient = require('bittorrent-tracker') as any;

const ROOM_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

const w = window as any;
const nativeWrtc = {
  RTCPeerConnection: w.RTCPeerConnection,
  RTCSessionDescription: w.RTCSessionDescription,
  RTCIceCandidate: w.RTCIceCandidate,
};

const PING_INTERVAL = 15000;   // heartbeat to peers
const OFFLINE_AFTER = 45000;   // mark a member offline after this silence
const SNAPSHOT_THROTTLE = 700; // min ms between pushed state snapshots per room

function log(msg: string): void { try { ipcRenderer.send('room-log', msg); } catch { /* ignore */ } }

// ── Gossip message shapes (post-decrypt) ───────────────────────────────────
type Msg =
  | { t: 'hello'; memberId: string; name: string; avatarSeed: string; have: string[]; files: RoomFile[] }
  | { t: 'add'; file: RoomFile }
  | { t: 'have'; memberId: string; fileId: string }
  | { t: 'ping'; memberId: string; name: string; avatarSeed: string; have: string[] };

interface Wire { id: number; peer: any; memberId?: string; }

interface Room {
  roomId: string;
  name: string;
  code: string;
  folder: string;
  key: Buffer;
  topic: string;
  peerId: string;
  iceServers: any[];
  tracker: any;
  started: boolean;
  self: { memberId: string; name: string; avatarSeed: string };
  wires: Map<number, Wire>;
  members: Map<string, RoomMember>;      // by memberId (excludes self)
  files: Map<string, RoomFile>;          // by fileId
  transfers: Map<string, RoomTransfer>;  // by fileId
  snapshotTimer: any;
  lastSnapshot: number;
}

let client: any = null;                  // shared WebTorrent client for transfers
const rooms = new Map<string, Room>();
let wireSeq = 0;

function ensureClient(iceServers: any[]): any {
  if (!client) {
    client = new WebTorrent({
      utp: false,
      dht: false,
      tracker: { wrtc: nativeWrtc, rtcConfig: { iceServers } },
    } as any);
    client.on('error', (e: any) => log('wt client error: ' + (e?.message || e)));
    log('WebTorrent client ready (Chromium WebRTC)');
  }
  return client;
}

// ── Snapshot / state push ──────────────────────────────────────────────────
function buildState(room: Room): RoomState {
  const now = Date.now();
  const self: RoomMember = {
    memberId: room.self.memberId,
    name: room.self.name || 'You',
    avatarSeed: room.self.avatarSeed,
    online: true,
    isSelf: true,
    lastSeen: now,
    have: Array.from(room.files.values())
      .filter((f) => room.transfers.get(f.fileId)?.haveLocally)
      .map((f) => f.fileId),
  };
  const members: RoomMember[] = [self];
  for (const m of room.members.values()) {
    members.push({ ...m, online: now - m.lastSeen < OFFLINE_AFTER, isSelf: false });
  }
  const transfers: Record<string, RoomTransfer> = {};
  for (const [k, v] of room.transfers) transfers[k] = v;
  return {
    roomId: room.roomId,
    name: room.name,
    code: room.code,
    folder: room.folder,
    topicHash: room.topic,
    createdAt: 0,
    members,
    files: Array.from(room.files.values()).sort((a, b) => a.addedAt - b.addedAt),
    transfers,
    connected: room.started,
    peerCount: room.wires.size,
  };
}

function pushState(room: Room, immediate = false): void {
  const send = () => {
    room.lastSnapshot = Date.now();
    room.snapshotTimer = null;
    try { ipcRenderer.send('room-update', buildState(room)); } catch { /* ignore */ }
  };
  if (immediate) { if (room.snapshotTimer) { clearTimeout(room.snapshotTimer); } send(); return; }
  if (room.snapshotTimer) return;
  const wait = Math.max(0, SNAPSHOT_THROTTLE - (Date.now() - room.lastSnapshot));
  room.snapshotTimer = setTimeout(send, wait);
}

// ── Gossip ──────────────────────────────────────────────────────────────────
function sendTo(room: Room, wire: Wire, msg: Msg): void {
  try {
    if (wire.peer && wire.peer.connected) wire.peer.send(encrypt(room.key, msg));
  } catch (e) { log('send failed: ' + String(e)); }
}

function broadcast(room: Room, msg: Msg): void {
  for (const wire of room.wires.values()) sendTo(room, wire, msg);
}

function helloMsg(room: Room): Msg {
  return {
    t: 'hello',
    memberId: room.self.memberId,
    name: room.self.name || 'You',
    avatarSeed: room.self.avatarSeed,
    have: buildState(room).members[0].have,
    files: Array.from(room.files.values()),
  };
}

function touchMember(room: Room, memberId: string, name: string, avatarSeed: string): RoomMember {
  let m = room.members.get(memberId);
  if (!m) {
    m = { memberId, name, avatarSeed, online: true, isSelf: false, lastSeen: Date.now(), have: [] };
    room.members.set(memberId, m);
  } else {
    m.name = name || m.name;
    m.avatarSeed = avatarSeed || m.avatarSeed;
    m.lastSeen = Date.now();
  }
  return m;
}

function onMessage(room: Room, wire: Wire, raw: any): void {
  let msg: Msg;
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    msg = decrypt<Msg>(room.key, text);
  } catch {
    // Wrong key / not a member / corrupt — ignore silently.
    return;
  }
  switch (msg.t) {
    case 'hello': {
      wire.memberId = msg.memberId;
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      m.have = Array.from(new Set(msg.have || []));
      for (const f of msg.files || []) mergeFile(room, f);
      pushState(room);
      break;
    }
    case 'ping': {
      wire.memberId = msg.memberId;
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      m.have = Array.from(new Set(msg.have || []));
      pushState(room);
      break;
    }
    case 'add': {
      mergeFile(room, msg.file);
      pushState(room);
      break;
    }
    case 'have': {
      const m = room.members.get(msg.memberId);
      if (m && !m.have.includes(msg.fileId)) { m.have.push(msg.fileId); m.lastSeen = Date.now(); }
      pushState(room);
      break;
    }
  }
}

function attachWire(room: Room, peer: any): void {
  const wire: Wire = { id: ++wireSeq, peer };
  room.wires.set(wire.id, wire);
  const greet = () => sendTo(room, wire, helloMsg(room));
  if (peer.connected) greet(); else peer.once('connect', greet);
  peer.on('data', (d: any) => onMessage(room, wire, d));
  peer.on('close', () => { room.wires.delete(wire.id); pushState(room); });
  peer.on('error', () => { /* transient WebRTC noise */ });
  pushState(room);
}

// ── File manifest + transfers ────────────────────────────────────────────────
function mergeFile(room: Room, file: RoomFile): void {
  if (!file || !file.fileId) return;
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    ensureLocal(room, file);
  }
}

function setTransfer(room: Room, fileId: string, patch: Partial<RoomTransfer>): void {
  const prev = room.transfers.get(fileId) || { fileId, progress: 0, status: 'queued' as const, downSpeed: 0, peers: 0, haveLocally: false };
  room.transfers.set(fileId, { ...prev, ...patch, fileId });
}

/** Seed a local file the user added, returning a RoomFile manifest entry. */
function seedLocal(room: Room, filePath: string): Promise<RoomFile> {
  const c = ensureClient(room.iceServers);
  const name = path.basename(filePath);
  return new Promise<RoomFile>((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error('File not found: ' + filePath));
    let settled = false;
    const onErr = (e: any) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
    c.once('error', onErr);
    try {
      c.seed(filePath, { announce: ROOM_TRACKERS, name } as any, (torrent: any) => {
        if (settled) return; settled = true;
        c.removeListener('error', onErr);
        const file: RoomFile = {
          fileId: torrent.infoHash,
          name,
          size: torrent.length || 0,
          infoHash: torrent.infoHash,
          magnetURI: torrent.magnetURI,
          addedBy: room.self.memberId,
          addedByName: room.self.name || 'You',
          addedAt: Date.now(),
        };
        setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true });
        wireTorrentStats(room, torrent);
        resolve(file);
      });
    } catch (e) { onErr(e); }
  });
}

/** Make sure a manifest file exists locally — seed it if already on disk,
 *  otherwise download it into the room folder over the WebTorrent swarm. */
function ensureLocal(room: Room, file: RoomFile): void {
  const c = ensureClient(room.iceServers);
  if (c.get(file.infoHash)) return; // already adding/seeding

  const onDisk = path.join(room.folder, file.name);
  if (fs.existsSync(onDisk)) {
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true });
    try {
      c.seed(onDisk, { announce: ROOM_TRACKERS, name: file.name } as any, (t: any) => wireTorrentStats(room, t));
    } catch (e) { log('reseed failed: ' + String(e)); }
    return;
  }

  setTransfer(room, file.fileId, { status: 'downloading', progress: 0 });
  try {
    c.add(file.magnetURI, { path: room.folder, announce: ROOM_TRACKERS } as any, (torrent: any) => {
      wireTorrentStats(room, torrent);
      torrent.on('done', () => {
        setTransfer(room, file.fileId, { progress: 1, status: 'seeding', downSpeed: 0, haveLocally: true });
        broadcast(room, { t: 'have', memberId: room.self.memberId, fileId: file.fileId });
        pushState(room, true);
      });
    });
  } catch (e) {
    setTransfer(room, file.fileId, { status: 'error' });
    log('download add failed: ' + String(e));
  }
}

function wireTorrentStats(room: Room, torrent: any): void {
  const fileId = torrent.infoHash;
  const update = () => {
    const done = torrent.progress >= 1 || torrent.done;
    setTransfer(room, fileId, {
      progress: torrent.progress || (done ? 1 : 0),
      status: done ? 'seeding' : 'downloading',
      downSpeed: torrent.downloadSpeed || 0,
      peers: torrent.numPeers || 0,
      haveLocally: done || (room.transfers.get(fileId)?.haveLocally ?? false),
    });
    pushState(room);
  };
  torrent.on('download', update);
  torrent.on('upload', update);
  torrent.on('wire', update);
  torrent.on('error', () => setTransfer(room, fileId, { status: 'error' }));
  update();
}

// ── Room lifecycle ───────────────────────────────────────────────────────────
function startRoom(p: { roomId: string; name: string; code: string; folder: string;
  self: { memberId: string; name: string; avatarSeed: string }; useTurn: boolean; turnServers?: any[] }): RoomState {
  let room = rooms.get(p.roomId);
  if (room) return buildState(room);

  try { fs.mkdirSync(p.folder, { recursive: true }); } catch { /* ignore */ }

  const iceServers = p.useTurn && p.turnServers && p.turnServers.length
    ? STUN_SERVERS.concat(p.turnServers)
    : STUN_SERVERS.slice();

  room = {
    roomId: p.roomId,
    name: p.name,
    code: p.code,
    folder: p.folder,
    key: deriveKey(p.code),
    topic: topicHash(p.code),
    peerId: randomPeerId(),
    iceServers,
    tracker: null,
    started: false,
    self: p.self,
    wires: new Map(),
    members: new Map(),
    files: new Map(),
    transfers: new Map(),
    snapshotTimer: null,
    lastSnapshot: 0,
  };
  rooms.set(p.roomId, room);

  // Adopt any files already sitting in the room folder (re-share on restart).
  try {
    for (const entry of fs.readdirSync(room.folder)) {
      const full = path.join(room.folder, entry);
      if (fs.statSync(full).isFile()) {
        seedLocal(room, full).then((f) => { mergeFileLocal(room!, f); }).catch(() => { /* ignore */ });
      }
    }
  } catch { /* folder may be empty */ }

  // Rendezvous tracker.
  try {
    const tracker = new TrackerClient({
      infoHash: room.topic,
      peerId: room.peerId,
      announce: ROOM_TRACKERS,
      port: 6881,
      rtcConfig: { iceServers },
      wrtc: nativeWrtc,
    });
    room.tracker = tracker;
    tracker.on('peer', (peer: any) => attachWire(room!, peer));
    tracker.on('warning', () => { /* tracker noise */ });
    tracker.on('error', (e: any) => log('tracker error: ' + (e?.message || e)));
    tracker.on('update', () => { room!.started = true; });
    tracker.start();
    room.started = true;
    log('Room joined: ' + p.name + ' (' + room.topic.slice(0, 8) + ')');
  } catch (e) {
    log('tracker start failed: ' + String(e));
  }

  // Heartbeat.
  const beat = setInterval(() => {
    const r = rooms.get(p.roomId);
    if (!r) { clearInterval(beat); return; }
    broadcast(r, { t: 'ping', memberId: r.self.memberId, name: r.self.name || 'You', avatarSeed: r.self.avatarSeed, have: buildState(r).members[0].have });
    pushState(r);
  }, PING_INTERVAL);

  pushState(room, true);
  return buildState(room);
}

/** A locally-seeded file: register in manifest + announce to peers. */
function mergeFileLocal(room: Room, file: RoomFile): void {
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true });
    broadcast(room, { t: 'add', file });
    pushState(room, true);
  }
}

async function addFiles(roomId: string, paths: string[]): Promise<RoomState> {
  const room = rooms.get(roomId);
  if (!room) throw new Error('Room not active');
  for (const p of paths) {
    try {
      const file = await seedLocal(room, p);
      mergeFileLocal(room, file);
    } catch (e) { log('addFile failed: ' + String(e)); }
  }
  return buildState(room);
}

function leaveRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  try { room.tracker?.stop(); room.tracker?.destroy(); } catch { /* ignore */ }
  for (const wire of room.wires.values()) { try { wire.peer.destroy(); } catch { /* ignore */ } }
  // Stop transferring this room's torrents (only if no other room uses them).
  if (client) {
    for (const fileId of room.files.keys()) {
      const stillUsed = Array.from(rooms.values()).some((r) => r.files.has(fileId));
      if (!stillUsed) { const t = client.get(fileId); if (t) { try { client.remove(t); } catch { /* ignore */ } } }
    }
  }
}

// ── IPC command router ───────────────────────────────────────────────────────
ipcRenderer.on('room-cmd', async (_e, msg: any) => {
  const { type, reqId } = msg;
  try {
    let data: any;
    if (type === 'join') data = startRoom(msg.payload);
    else if (type === 'addFiles') data = await addFiles(msg.roomId, msg.paths);
    else if (type === 'leave') { leaveRoom(msg.roomId); data = { ok: true }; }
    else if (type === 'snapshot') { const r = rooms.get(msg.roomId); data = r ? buildState(r) : null; }
    else throw new Error('Unknown room command: ' + type);
    ipcRenderer.send('room-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('room-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('room-ready');
