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
import { STUN_SERVERS } from './ice-servers';

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
  | { t: 'hello'; memberId: string; name: string; avatarSeed: string; have: string[]; files: RoomFile[]; tombs: string[]; roomName: string }
  | { t: 'add'; file: RoomFile }
  | { t: 'have'; memberId: string; fileId: string }
  | { t: 'ping'; memberId: string; name: string; avatarSeed: string; have: string[]; roomName: string }
  // Remove a shared file from the room (everyone drops it; tombstone prevents resurrection).
  | { t: 'del'; fileId: string; memberId: string }
  // Watch-together: relayed verbatim to peers; the renderers keep playback in sync
  // and show who's in the session ('join'/'leave'/'beat' presence).
  | { t: 'sync'; fileId: string; action: 'play' | 'pause' | 'seek' | 'state' | 'join' | 'leave' | 'beat'; position: number; rate: number; at: number; memberId: string; name: string; avatarSeed: string; playing: boolean };

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
  tombstones: Set<string>;               // deleted fileIds — never re-add them
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
  // Count distinct *members* that are online, not raw WebRTC wires — multiple
  // trackers each broker a wire to the same peer, so wires.size over-counts.
  const onlinePeers = members.filter((m) => !m.isSelf && m.online).length;
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
    peerCount: onlinePeers,
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
    tombs: Array.from(room.tombstones), // share deletions so peers converge
    roomName: room.name, // so a joiner (who only knows the code) learns the name
  };
}

/**
 * Adopt a friendlier room name a peer advertised. A joiner starts with its name
 * set to the invite code (it has nothing better); the creator broadcasts the
 * real name in HELLO/PING. Only adopt when ours is still the code placeholder
 * and the incoming name is a real one — and tell the main process to persist it.
 */
function maybeAdoptRoomName(room: Room, incoming?: string): void {
  if (!incoming || incoming === room.code) return;   // empty or still a placeholder
  if (room.name && room.name !== room.code) return;   // we already have a real name
  room.name = incoming;
  try { ipcRenderer.send('room-name', { roomId: room.roomId, name: incoming }); } catch { /* ignore */ }
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
      maybeAdoptRoomName(room, msg.roomName);
      // Apply peer deletions first so their HELLO file list can't re-add them.
      for (const id of msg.tombs || []) applyTombstone(room, id);
      for (const f of msg.files || []) mergeFile(room, f);
      pushState(room);
      break;
    }
    case 'ping': {
      wire.memberId = msg.memberId;
      const m = touchMember(room, msg.memberId, msg.name, msg.avatarSeed);
      m.have = Array.from(new Set(msg.have || []));
      maybeAdoptRoomName(room, msg.roomName);
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
    case 'del': {
      applyTombstone(room, msg.fileId);
      try { ipcRenderer.send('room-tomb', { roomId: room.roomId, fileId: msg.fileId }); } catch { /* ignore */ }
      pushState(room, true);
      break;
    }
    case 'sync': {
      // Relay watch-together control + presence to the main process → renderer.
      try {
        ipcRenderer.send('room-sync', {
          roomId: room.roomId, fileId: msg.fileId, action: msg.action,
          position: msg.position, rate: msg.rate, at: msg.at,
          memberId: msg.memberId, name: msg.name, avatarSeed: msg.avatarSeed, playing: msg.playing,
        });
      } catch { /* ignore */ }
      break;
    }
  }
}

/**
 * Drop a file from this room and never accept it again. Removes it from the
 * manifest/transfers, stops the torrent, and deletes the on-disk copy only when
 * it lives inside the room folder (never the original a member shared from).
 */
function applyTombstone(room: Room, fileId: string): void {
  room.tombstones.add(fileId);
  const tr = room.transfers.get(fileId);
  if (client) { const t = client.get(fileId); if (t) { try { client.remove(t); } catch { /* ignore */ } } }
  room.files.delete(fileId);
  room.transfers.delete(fileId);
  for (const m of room.members.values()) m.have = m.have.filter((id) => id !== fileId);
  // Delete the downloaded copy (only if it's inside the room folder).
  try {
    const lp = tr?.localPath;
    if (lp && path.resolve(lp).startsWith(path.resolve(room.folder) + path.sep) && fs.existsSync(lp)) {
      fs.unlinkSync(lp);
    }
  } catch (e) { log('tombstone unlink failed: ' + String(e)); }
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
  if (room.tombstones.has(file.fileId)) return; // deleted — don't let a peer resurrect it
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
        setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: filePath });
        wireTorrentStats(room, torrent);
        resolve(file);
      });
    } catch (e) { onErr(e); }
  });
}

/** Make sure a manifest file exists locally — seed it if already on disk,
 *  otherwise download it into the room folder over the WebTorrent swarm. */
function ensureLocal(room: Room, file: RoomFile): void {
  if (room.tombstones.has(file.fileId)) return; // deleted — don't fetch it again
  const c = ensureClient(room.iceServers);
  if (c.get(file.infoHash)) return; // already adding/seeding

  const onDisk = path.join(room.folder, file.name);
  if (fs.existsSync(onDisk)) {
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, localPath: onDisk });
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
        setTransfer(room, file.fileId, { progress: 1, status: 'seeding', downSpeed: 0, haveLocally: true, localPath: path.join(room.folder, file.name) });
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
  self: { memberId: string; name: string; avatarSeed: string }; useTurn: boolean; turnServers?: any[]; tombstones?: string[] }): RoomState {
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
    tombstones: new Set(p.tombstones || []),
    snapshotTimer: null,
    lastSnapshot: 0,
  };
  rooms.set(p.roomId, room);

  // Adopt any files already sitting in the room folder (re-share on restart).
  try {
    for (const entry of fs.readdirSync(room.folder)) {
      const full = path.join(room.folder, entry);
      if (fs.statSync(full).isFile()) {
        seedLocal(room, full).then((f) => { mergeFileLocal(room!, f, full); }).catch(() => { /* ignore */ });
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
    broadcast(r, { t: 'ping', memberId: r.self.memberId, name: r.self.name || 'You', avatarSeed: r.self.avatarSeed, have: buildState(r).members[0].have, roomName: r.name });
    pushState(r);
  }, PING_INTERVAL);

  pushState(room, true);
  return buildState(room);
}

/** A locally-seeded file: register in manifest + announce to peers. */
function mergeFileLocal(room: Room, file: RoomFile, localPath?: string): void {
  if (room.tombstones.has(file.fileId)) return;
  if (!room.files.has(file.fileId)) {
    room.files.set(file.fileId, file);
    setTransfer(room, file.fileId, { progress: 1, status: 'seeding', haveLocally: true, ...(localPath ? { localPath } : {}) });
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
      mergeFileLocal(room, file, p);
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

/**
 * Stop seeding a file so Windows releases the on-disk handle (lets the user open
 * or extract an archive). The file stays on disk and in the manifest — we just
 * remove the torrent from the WebTorrent client. Other members keep it.
 */
function releaseFile(roomId: string, fileId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  // Only drop the torrent if no other active room still shares this file.
  const stillUsedElsewhere = Array.from(rooms.values()).some((r) => r !== room && r.files.has(fileId));
  if (client && !stillUsedElsewhere) {
    const t = client.get(fileId);
    if (t) { try { client.remove(t); } catch (e) { log('release failed: ' + String(e)); } }
  }
  const tr = room.transfers.get(fileId);
  if (tr) { tr.status = 'done'; tr.released = true; tr.downSpeed = 0; tr.peers = 0; }
  pushState(room, true);
}

/** Apply a profile change (name/avatar) to every active room and tell peers. */
function updateProfile(p: { name?: string; avatarSeed?: string }): void {
  for (const room of rooms.values()) {
    if (typeof p.name === 'string') room.self.name = p.name;
    if (typeof p.avatarSeed === 'string' && p.avatarSeed) room.self.avatarSeed = p.avatarSeed;
    broadcast(room, { t: 'ping', memberId: room.self.memberId, name: room.self.name || 'You', avatarSeed: room.self.avatarSeed, have: buildState(room).members[0].have, roomName: room.name });
    pushState(room, true);
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
    else if (type === 'profile') { updateProfile(msg.payload || {}); data = { ok: true }; }
    else if (type === 'releaseFile') { releaseFile(msg.roomId, msg.fileId); data = { ok: true }; }
    else if (type === 'removeFile') {
      const r = rooms.get(msg.roomId);
      if (r) {
        applyTombstone(r, msg.fileId);
        broadcast(r, { t: 'del', fileId: msg.fileId, memberId: r.self.memberId });
        pushState(r, true);
      }
      data = { ok: true };
    }
    else if (type === 'sync') {
      const r = rooms.get(msg.roomId);
      const p = msg.payload || {};
      if (r) broadcast(r, {
        t: 'sync', fileId: String(p.fileId || ''), action: p.action || 'state',
        position: Number(p.position) || 0, rate: Number(p.rate) || 1, at: Date.now(),
        memberId: r.self.memberId, name: r.self.name || 'You',
        avatarSeed: r.self.avatarSeed, playing: !!p.playing,
      });
      data = { ok: true };
    }
    else if (type === 'snapshot') { const r = rooms.get(msg.roomId); data = r ? buildState(r) : null; }
    else throw new Error('Unknown room command: ' + type);
    ipcRenderer.send('room-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('room-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('room-ready');
