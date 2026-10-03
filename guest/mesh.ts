import { WatchHostState, type WatchPolicy } from '../shared/room-watch-host';
import { roomHelloParts, RoomHelloAssembly, RoomHelloOutbox, ROOM_FILE_LIMIT, roomChannelHasCapacity, roomManifestCanFit, storeRoomManifestFile } from '../shared/room-manifest-sync';
/**
 * Browser guest mesh — announce, gossip, chat, voice signaling, watch-sync.
 * Relays the same RELAYABLE set as the desktop engine so a guest can still
 * help a NAT pair (and so LAN/server frames keep flowing through them).
 */

import { banSnapshotCanonical, validBanSnapshot, banSnapshotAdvances, copyBanSnapshot, type RoomBanSnapshot } from '../shared/room-bans';
import { validateGossip, RoomIngressBudget, ROOM_RELAY_TYPES, ROOM_MEMBER_LIMIT, ROOM_IDENTITY_LIMIT, ROOM_WIRE_LIMIT, type GossipMessage } from '../shared/room-protocol';
import { roomFileName, ownerChainAdvances, ownerChainsCompatible, orderedTransferPrefix, transferCanonical, canDeleteRoomFile, canReviveRoomFile, currentRoomDeletion, type OwnerTransfer } from '../shared/room-authority';
import { ROOM_PROTOCOL_VERSION, GUEST_ROOM_CAPABILITIES, readRoomCapabilities, type RoomCapabilities } from '../shared/room-capabilities';
import { gossipProofs } from '../shared/room-message-auth';
import { WatchSender, WatchReceiver, watchCanonical, watchHostCanonical, type WatchInput, type WatchPlaybackEvent } from '../shared/room-watch-sync';
import { parseInvite, codeIsE2E } from '../shared/room-invite';
import {
  chatCanonical, chatContextCanonical, editCanonical, voiceStateCanonical, voiceStateV2Canonical, voiceSignalCanonical,
  rekeyCanonical, kickedCanonical, renameCanonical, topicCanonical, profileCanonical,
} from '../shared/room-canonicals';
import { CHAT_REACT_EMOJIS } from '../shared/reactions';
import { ROOM_CHAT_LIMIT, chatEnvelope, chatBackfillPages, retainRoomChat, upgradeChat, validChatTime } from '../shared/room-chat-history';
import type { RoomChatMessage, RoomFile } from '../shared/types';
import { classifyMediaKind, isDirectlyPlayable } from '../shared/media';
import {
  deriveKeyWeb, topicHashWeb, rendezvousIdWeb, encryptWeb, decryptWeb,
  signWeb, verifyWeb, deriveMemberIdWeb, randomHex,
  type GuestIdentity,
} from '../shared/room-web-crypto';
import { PUBLIC_STUN_SERVERS } from '../shared/room-guest-url';
import { startRendezvous, type DataWire } from './tracker';
import { GuestVoice, type SignalKind, type VoiceParticipant } from './voice';

const PING_MS = 15_000;
const OFFLINE_MS = 45_000;
const RELAY_TTL = 4;
const SEEN_CAP = 4096;
const MAX_FRAME = 1_000_000;
const MAX_TEXT = 2000;
const MAX_STR = 1024;
const MAX_CHAT = ROOM_CHAT_LIMIT;
const MAX_TOPIC = 300;
const TYPING_TTL = 4000;
const TYPING_MIN = 2000;
const REACT_SET = new Set<string>(CHAT_REACT_EMOJIS);

const RELAYABLE = ROOM_RELAY_TYPES;

function clampStr(v: unknown, n: number): string {
  return typeof v === 'string' ? v.slice(0, n) : '';
}


export interface GuestMember extends RoomCapabilities {
  memberId: string;
  name: string;
  avatarSeed: string;
  online: boolean;
  isSelf: boolean;
  lastSeen: number;
  role: 'owner' | 'member';
  guest?: boolean;
  color?: string;
  relayed?: boolean;
  watchSync?: boolean;
}

export type GuestChat = RoomChatMessage;

export interface GuestFile extends RoomFile {
  fileId: string;
  name: string;
  size: number;
  magnetURI: string;
  enc?: boolean;
  playable: boolean;
}

export type SyncEvent = WatchPlaybackEvent;

export interface GuestSnapshot {
  roomName: string;
  watchPolicy?: WatchPolicy;
  topic: string;
  e2e: boolean;
  connected: boolean;
  peerCount: number;
  kicked: boolean;
  kickedBy: string;
  members: GuestMember[];
  chat: GuestChat[];
  chatEdits: Record<string, string>;
  chatReacts: Record<string, Record<string, string[]>>;
  typingIds: string[];
  files: GuestFile[];
  voice: { inVoice: boolean; muted: boolean; deafened: boolean; micUnavailable?: boolean; participants: VoiceParticipant[] };
}

interface WireRec { id: number; wire: DataWire; memberId?: string; greetedFull?: boolean; legacyChatSent?: boolean }

export class GuestRoom {
  readonly identity: GuestIdentity;
  readonly name: string;
  readonly avatarSeed: string;
  roomName = '';
  topicText = '';
  e2e = false;
  ownerId = '';
  ownerPin = '';
  nameAt = 0;
  topicAt = 0;
  kicked = false;
  kickedBy = '';
  connected = false;
  private leaving = false;

  private key!: Uint8Array;
  private ingress = new RoomIngressBudget();
  private wireIngress = new WeakMap<WireRec, RoomIngressBudget>();
  private watchHost = new WatchHostState();
  private watchPolicyTopic = '';
  private watchSender = new WatchSender();
  private watchReceiver = new WatchReceiver();
  private transferChain: OwnerTransfer[] = [];
  private transferAt = 0;
  private frameChain: Promise<void> = Promise.resolve();
  private tombs = new Map<string, { at: number; by: string; pub: string; sig: string; topic: string }>();
  private pendingTombs = new Map<string, { at: number; by: string; pub: string; sig: string }>();
  private revives = new Map<string, number>();
  private voiceV2 = new Set<string>();
  private topic = '';
  private rendezvous = '';
  private code = '';
  private ice: RTCIceServer[];
  private trackers: string[];
  private rv: { stop: () => void } | null = null;
  private wires = new Map<number, WireRec>();
  private wireSeq = 0;
  private queuedFrameChars = 0;
  private members = new Map<string, GuestMember>();
  private identities = new Map<string, string>();
  private chat: GuestChat[] = [];
  private chatEdits = new Map<string, { text: string; at: number; by: string; pub: string; sig: string }>();
  private chatEditTopics = new Map<string, string>();
  private pendingEdits = new Map<string, { text: string; at: number; memberId: string; pub: string; sig: string }>();
  private chatReacts = new Map<string, Map<string, Set<string>>>();
  private profileAt = new Map<string, number>();
  private files = new Map<string, GuestFile>();
  private typing: Record<string, number> = {};
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private bans = new Set<string>();
  private banState: RoomBanSnapshot | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastTyping = 0;
  private onChange: () => void;
  readonly voice: GuestVoice;
  onSync: ((ev: SyncEvent) => void) | null = null;

  constructor(opts: {
    identity: GuestIdentity;
    name: string;
    avatarSeed: string;
    iceServers?: RTCIceServer[];
    trackers: string[];
    onChange: () => void;
  }) {
    this.identity = opts.identity;
    this.name = opts.name.slice(0, 64) || 'Guest';
    this.avatarSeed = opts.avatarSeed;
    this.ice = opts.iceServers?.length ? opts.iceServers : [...PUBLIC_STUN_SERVERS];
    this.trackers = opts.trackers;
    this.onChange = opts.onChange;
    this.voice = new GuestVoice({
      selfId: this.identity.memberId,
      iceServers: this.ice,
      sendSignal: (to, kind, data) => { void this.sendVoiceSignal(to, kind, data); },
      announce: (inVoice, muted, at, deafened) => { void this.sendVoiceState(inVoice, muted, at, deafened); },
      onChange: () => this.onChange(),
    });
  }

  async join(rawInvite: string): Promise<void> {
    const { code, ownerPin } = parseInvite(rawInvite);
    if (code.length < 8) throw new Error('bad-invite');
    this.code = code;
    this.ownerPin = ownerPin;
    this.e2e = codeIsE2E(code);
    this.roomName = code;
    this.key = await deriveKeyWeb(code);
    this.topic = await topicHashWeb(code);
    this.rendezvous = await rendezvousIdWeb(this.key);
    this.identities.set(this.identity.memberId, this.identity.pub);
    this.rv = startRendezvous({
      infoHashHex: this.rendezvous,
      peerIdHex: randomHex(20),
      announce: this.trackers,
      iceServers: this.ice,
      onPeer: (wire) => this.attach(wire),
    });
    this.connected = true;
    this.pingTimer = setInterval(() => { void this.broadcast(this.pingMsg()); }, PING_MS);
    this.onChange();
  }

  leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    const bye = { t: 'bye', memberId: this.identity.memberId, _g: randomHex(6), _t: RELAY_TTL };
    this.markSeen(String(bye._g));
    void encryptWeb(this.key, bye).then((token) => {
      for (const rec of this.wires.values()) {
        try { rec.wire.send(token); } catch { /* ignore */ }
      }
      this.teardown();
    }).catch(() => this.teardown());
    setTimeout(() => this.teardown(), 400);
  }

  private helloAssembly = new RoomHelloAssembly(256, false);
  private directHelloAssemblies = new WeakMap<WireRec, RoomHelloAssembly>();
  private helloOutbox = new RoomHelloOutbox();
  private helloClock = 0;
  private torn = false;

  private teardown(): void {
    if (this.torn) return;
    this.torn = true;
    this.helloOutbox.stop(); this.helloAssembly.clear();
    this.voice.leave();
    this.rv?.stop();
    this.rv = null;
    for (const w of this.wires.values()) w.wire.destroy();
    this.wires.clear();
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.connected = false;
    this.onChange();
  }

  snapshot(): GuestSnapshot {
    const now = Date.now();
    const self: GuestMember = {
      memberId: this.identity.memberId,
      name: this.name,
      avatarSeed: this.avatarSeed,
      online: true,
      isSelf: true,
      lastSeen: now,
      role: 'member', // This browser cannot execute owner management commands.
      protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...GUEST_ROOM_CAPABILITIES],
      guest: true,
    };
    const direct = new Set<string>();
    for (const w of this.wires.values()) if (w.memberId) direct.add(w.memberId);
    const members = [self];
    for (const m of this.members.values()) {
      if (m.memberId === self.memberId) continue;
      const online = now - m.lastSeen < OFFLINE_MS;
      members.push({
        ...m,
        online,
        isSelf: false,
        role: this.ownerId && m.memberId === this.ownerId ? 'owner' : 'member',
        relayed: online && !direct.has(m.memberId),
      });
    }
    const typingIds = Object.entries(this.typing)
      .filter(([id, at]) => id !== self.memberId && now - at < TYPING_TTL && this.members.has(id))
      .map(([id]) => id);
    const chatReacts: Record<string, Record<string, string[]>> = {};
    for (const [msgId, byEmoji] of this.chatReacts) {
      const rec: Record<string, string[]> = {};
      for (const [em, ids] of byEmoji) rec[em] = [...ids];
      chatReacts[msgId] = rec;
    }
    return {
      roomName: this.roomName,
      watchPolicy: this.watchHost.current(this.ownerId, this.transferAt),
      topic: this.topicText,
      e2e: this.e2e,
      connected: this.connected && this.wires.size > 0,
      peerCount: members.filter((m) => !m.isSelf && m.online).length,
      kicked: this.kicked,
      kickedBy: this.kickedBy,
      members,
      chat: this.chat.slice(),
      chatEdits: Object.fromEntries([...this.chatEdits].map(([id, e]) => [id, e.text])),
      chatReacts,
      typingIds,
      files: [...this.files.values()],
      voice: {
        inVoice: this.voice.inVoice,
        muted: this.voice.muted,
        deafened: this.voice.deafened,
        ...(this.voice.micUnavailable ? { micUnavailable: true } : {}),
        participants: this.voice.participants(),
      },
    };
  }

  async sendChat(text: string, replyTo?: string): Promise<void> {
    const body = text.trim().slice(0, MAX_TEXT);
    if (!body || this.kicked) return;
    const msg: GuestChat = {
      id: randomHex(8),
      at: Date.now(),
      memberId: this.identity.memberId,
      name: this.name,
      avatarSeed: this.avatarSeed,
      text: body,
    };
    if (replyTo) {
      msg.replyTo = replyTo;
      const parent = this.chat.find((c) => c.id === replyTo);
      if (parent) {
        msg.replyTo = parent.id;
        msg.replyName = parent.name.slice(0, 256);
        msg.replyText = (this.chatEdits.get(parent.id)?.text ?? parent.text).slice(0, 140);
      }
    }
    const sig = await signWeb(this.identity.priv, chatCanonical(this.topic, msg));
    msg.pub = this.identity.pub;
    msg.sig = sig;
    msg.chatV = 2;
    msg.contextSig = await signWeb(this.identity.priv, chatContextCanonical(this.topic, msg));
    this.addChat(msg);
    await this.broadcast({ t: 'chat', ...msg, pub: this.identity.pub, sig });
    this.onChange();
  }

  sendTyping(): void {
    const now = Date.now();
    if (now - this.lastTyping < TYPING_MIN) return;
    this.lastTyping = now;
    void this.broadcast({ t: 'typing', memberId: this.identity.memberId });
  }

  async toggleReact(msgId: string, emoji: string): Promise<void> {
    if (!REACT_SET.has(emoji)) return;
    let byEmoji = this.chatReacts.get(msgId);
    if (!byEmoji) { byEmoji = new Map(); this.chatReacts.set(msgId, byEmoji); }
    let ids = byEmoji.get(emoji);
    if (!ids) { ids = new Set(); byEmoji.set(emoji, ids); }
    const on = !ids.has(this.identity.memberId);
    if (on) ids.add(this.identity.memberId); else ids.delete(this.identity.memberId);
    await this.broadcast({ t: 'react-chat', memberId: this.identity.memberId, msgId, emoji, on });
    this.onChange();
  }

  async sendSync(ev: WatchInput & { at?: number; memberId?: string }): Promise<void> {
    if (!this.files.has(ev.fileId)) return;
    const body = this.watchSender.next({ ...ev, ...this.watchHost.stamp(this.ownerId, this.transferAt) }, this.identity.memberId, () => randomHex(16), Date.now(), 3);
    if (!body) return;
    const sig = await signWeb(this.identity.priv, watchCanonical(this.topic, body));
    const hostSig = await signWeb(this.identity.priv, watchHostCanonical(this.topic, body));
    const frame = { ...body, pub: this.identity.pub, sig, hostSig };
    if (!this.watchHost.allows(frame, this.ownerId, this.transferAt)) return;
    await this.broadcast(frame);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private helloMsg(full = true): Record<string, unknown> {
    const gid = randomHex(6);
    this.markSeen(gid);
    const m: Record<string, unknown> = {
      t: 'hello', manifestFull: full,
      _g: gid, _t: RELAY_TTL,
      memberId: this.identity.memberId,
      name: this.name,
      avatarSeed: this.avatarSeed,
      pub: this.identity.pub,
      have: [],
      files: [],
      tombs: [],
      roomName: this.roomName,
      ownerId: this.ownerId,
      e2e: this.e2e,
      secret: '',
      guest: true,
      chatSync: 2, watchSync: 2, protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...GUEST_ROOM_CAPABILITIES],
    };
    const policy = this.watchHost.current(this.ownerId, this.transferAt);
    if (policy && this.watchPolicyTopic === this.topic) m.watchPolicy = policy;
    if (this.banState?.ownerId === this.ownerId) m.banState = this.banState;
    if ((full || m.banState) && this.transferChain.length) m.transferChain = this.transferChain;
    if (full && this.tombs.size) m.tombSigs = Object.fromEntries([...this.tombs].filter(([, p]) => p.topic === this.topic && !this.bans.has(p.by)).slice(0, ROOM_FILE_LIMIT).map(([id, { topic: _topic, ...p }]) => [id, p]));
    if (full) m.chatIds = this.chat.filter(c => c.chatV === 2).map(c => c.id);
    if (full && this.chatEdits.size) m.chatEdits = Object.fromEntries([...this.chatEdits].filter(([id, e]) => this.chatEditTopics.get(id) === this.topic && !this.bans.has(e.by)));
    if (full && this.chat.length) m.chatAt = this.chat[this.chat.length - 1].at;
    return m;
  }

  private pingMsg(): Record<string, unknown> {
    return {
      t: 'ping',
      memberId: this.identity.memberId,
      name: this.name,
      avatarSeed: this.avatarSeed,
      have: [],
      roomName: this.roomName,
      ownerId: this.ownerId,
      guest: true,
      protocolVersion: ROOM_PROTOCOL_VERSION, capabilities: [...GUEST_ROOM_CAPABILITIES], watchSync: 2,
    };
  }

  private attach(wire: DataWire): void {
    if (this.wires.size >= ROOM_WIRE_LIMIT) { wire.destroy(); return; }
    const rec: WireRec = { id: ++this.wireSeq, wire };
    this.wires.set(rec.id, rec);
    const greet = () => { void this.sendTo(rec, this.helloMsg(false)); };
    if (wire.connected) greet();
    else {
      const wait = setInterval(() => {
        if (wire.connected) { clearInterval(wait); greet(); }
      }, 80);
      setTimeout(() => clearInterval(wait), 8000);
    }
    // WebCrypto is asynchronous: preserve RTC frame order while verifying pages.
    let frames = Promise.resolve(), queued = 0, queuedChars = 0;
    wire.onData((raw) => {
      if (raw.length > MAX_FRAME || queued >= 32 || queuedChars + raw.length > 2_000_000 || this.queuedFrameChars + raw.length > 4_000_000) return;
      queued++; queuedChars += raw.length; this.queuedFrameChars += raw.length;
      frames = frames.then(() => this.onFrame(rec, raw)).catch(() => {}).finally(() => { queued--; queuedChars -= raw.length; this.queuedFrameChars -= raw.length; });
    });
    wire.onClose(() => { this.wires.delete(rec.id); this.onChange(); });
    this.onChange();
  }

  private async sendTo(rec: WireRec, msg: Record<string, unknown>): Promise<void> {
    if (msg.t === 'hello' && msg.manifestFull === true && !msg.manifestPart) {
      this.helloClock = Math.max(Date.now(), this.helloClock + 1);
      const pages = roomHelloParts(msg, randomHex(12), this.helloClock);
      if (pages.length > 1) {
        for (const page of pages) if (page._g) this.markSeen(page._g);
        const key = this.key;
        this.helloOutbox.enqueue(rec, pages, page => { void this.sendTo(rec, page); }, () => {
          if (this.torn || this.key !== key || this.wires.get(rec.id) !== rec || !rec.wire.connected) return null;
          return roomChannelHasCapacity(rec.wire);
        });
        return;
      }
    }
    try {
      rec.wire.send(await encryptWeb(this.key, msg));
    } catch { /* ignore */ }
  }

  private markSeen(gid: string): void {
    if (this.seen.has(gid)) return;
    this.seen.add(gid);
    this.seenOrder.push(gid);
    while (this.seenOrder.length > SEEN_CAP) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }

  private async broadcast(msg: Record<string, unknown>): Promise<void> {
    if (RELAYABLE.has(String(msg.t)) && !msg._g) {
      msg._g = randomHex(6);
      msg._t = RELAY_TTL;
      this.markSeen(String(msg._g));
    }
    if (msg.t === 'hello' && msg.manifestFull === true) {
      for (const rec of this.wires.values()) if (rec.memberId && !this.bans.has(rec.memberId)) await this.sendTo(rec, msg);
      return;
    }
    const token = await encryptWeb(this.key, msg);
    for (const rec of this.wires.values()) {
      if (!rec.memberId || this.bans.has(rec.memberId)) continue;
      try { rec.wire.send(token); } catch { /* ignore */ }
    }
  }

  private async forward(msg: any, fromId: number): Promise<void> {
    const hops = Number(msg._t);
    if (!Number.isFinite(hops) || hops <= 1) return;
    msg._t = hops - 1;
    const token = msg.manifestPart ? null : await encryptWeb(this.key, msg);
    for (const rec of this.wires.values()) {
      if (rec.id === fromId) continue;
      if (!rec.memberId || this.bans.has(rec.memberId)) continue;
      if (msg.manifestPart) {
        const key = this.key;
        this.helloOutbox.relay({ ...msg }, page => { void this.sendTo(rec, page); }, () => {
          if (this.torn || this.key !== key || this.wires.get(rec.id) !== rec || !rec.wire.connected || this.bans.has(rec.memberId || '')) return null;
          return ((rec.wire as any)._channel?.bufferedAmount || 0) < 512 * 1024;
        });
      } else if (token !== null) try { rec.wire.send(token); } catch { /* ignore */ }
    }
  }

  private async verify(memberId: string, pub: string, sig: string, bytes: Uint8Array): Promise<boolean> {
    if (!memberId || !pub || !sig) return false;
    if (await deriveMemberIdWeb(pub) !== memberId) return false;
    const bound = this.identities.get(memberId);
    if (bound && bound !== pub) return false;
    if (!bound && this.identities.size >= ROOM_IDENTITY_LIMIT) return false;
    if (!(await verifyWeb(pub, bytes, sig))) return false;
    if (!this.identities.has(memberId) && this.identities.size >= ROOM_IDENTITY_LIMIT) return false;
    if (!this.identities.has(memberId)) this.identities.set(memberId, pub);
    return true;
  }

  private touch(memberId: string, name: string, avatarSeed: string, guest?: boolean): GuestMember {
    let m = this.members.get(memberId);
    if (!m) {
      m = { memberId, name, avatarSeed, online: true, isSelf: false, lastSeen: Date.now(), role: 'member', guest };
      this.members.set(memberId, m);
    } else {
      m.name = name || m.name;
      m.avatarSeed = avatarSeed || m.avatarSeed;
      m.lastSeen = Date.now();
      if (guest) m.guest = true;
    }
    return m;
  }

  private async adoptFile(f: RoomFile): Promise<void> {
    const fileId = clampStr(f?.fileId, MAX_STR);
    const magnetURI = clampStr(f?.magnetURI, 4096);
    const name = roomFileName(clampStr(f?.name, MAX_STR));
    if (!this.files.has(fileId) && !roomManifestCanFit(this.files, f)) return;
    if (!fileId || !/^\S+$/.test(fileId) || !magnetURI || !name || this.bans.has(f.addedBy)) return;
    const tomb = this.tombs.get(fileId), pending = this.pendingTombs.get(fileId);
    const deletion = tomb || (pending && canDeleteRoomFile(this.ownerId, f.addedBy, pending.by) ? pending : undefined);
    if (deletion) {
      if (!this.revives.has(fileId) && this.revives.size >= ROOM_FILE_LIMIT) return;
      if (f.revAt !== undefined && f.revAt >= deletion.at && f.revAt <= Date.now() + 60_000
        && f.revBy && f.revPub && f.revSig && canReviveRoomFile(this.ownerId, deletion.by, f.revBy)
        && await this.verify(f.revBy, f.revPub, f.revSig, new TextEncoder().encode(JSON.stringify(['revive', this.topic, fileId, f.revAt, f.revBy])))) {
        this.tombs.delete(fileId); this.pendingTombs.delete(fileId);
        this.revives.set(fileId, Math.max(this.revives.get(fileId) ?? 0, f.revAt));
      } else if (tomb) return; // A timestamp alone never revives an authenticated deletion.
      else if (canDeleteRoomFile(this.ownerId, f.addedBy, pending!.by)) {
        this.pendingTombs.delete(fileId);
        if (currentRoomDeletion(pending!.at, undefined, this.revives.get(fileId))
          && await this.verify(pending!.by, pending!.pub, pending!.sig, this.delBytes(fileId, pending!))) {
          this.tombs.set(fileId, { ...pending!, topic: this.topic }); return;
        }
      }
    }
    if (this.files.has(fileId) || this.files.size >= ROOM_FILE_LIMIT) return; // Preserve the first accepted author, as desktop does.
    storeRoomManifestFile(this.files, {
      ...f,
      fileId, name, magnetURI, infoHash: fileId, addedAt: Math.min(f.addedAt, Date.now()),
      size: Number.isFinite(f.size) ? f.size : 0,
      enc: f.enc === true,
      playable: f.enc !== true && classifyMediaKind(name) !== 'other' && isDirectlyPlayable(name),
    });
  }

  private delBytes(fileId: string, p: { by: string; at: number }): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(['del', this.topic, fileId, p.by, p.at]));
  }

  private async acceptTomb(fileId: string, p: { at: number; by: string; pub: string; sig: string }): Promise<void> {
    if (!this.tombs.has(fileId) && this.tombs.size >= ROOM_FILE_LIMIT) return;
    if (!currentRoomDeletion(p.at, undefined, this.revives.get(fileId))) return;
    const held = this.tombs.get(fileId);
    if (held && held.at > p.at || held?.at === p.at && held.topic === this.topic) return;
    const file = this.files.get(fileId);
    if (!canDeleteRoomFile(this.ownerId, file?.addedBy, p.by)) {
      if (!file && (!this.pendingTombs.has(fileId) || this.pendingTombs.get(fileId)!.at < p.at)) {
        this.pendingTombs.set(fileId, p);
        if (this.pendingTombs.size > 500) this.pendingTombs.delete(this.pendingTombs.keys().next().value!);
      }
      return;
    }
    if (!(await this.verify(p.by, p.pub, p.sig, this.delBytes(fileId, p)))) return;
    if (!currentRoomDeletion(p.at, file?.addedAt, this.revives.get(fileId))) return;
    this.revives.delete(fileId); this.pendingTombs.delete(fileId);
    this.tombs.set(fileId, { ...p, topic: this.topic }); this.files.delete(fileId);
  }

  private async adoptChain(links: unknown): Promise<boolean> {
    const chain = orderedTransferPrefix(links);
    if (!chain.length) return false;
    const verified: OwnerTransfer[] = [];
    for (const link of chain) {
      if (!(await this.verify(link.by, link.pub, link.sig, transferCanonical(chain[0].by, link)))) break;
      verified.push(link);
    }
    if (!ownerChainAdvances({ ownerId: this.ownerId, ownerPin: this.ownerPin, transferChain: this.transferChain, transferAt: this.transferAt }, verified) || this.bans.has(verified.at(-1)!.newOwnerId)) return false;
    this.transferChain = verified; this.transferAt = verified.at(-1)!.at;
    this.ownerId = verified.at(-1)!.newOwnerId;
    return true;
  }

  private async adoptBanState(proof: RoomBanSnapshot): Promise<boolean> {
    if (!validBanSnapshot(proof) || !banSnapshotAdvances(proof, this.ownerId, this.banState, this.bans)
      || !(await this.verify(proof.ownerId, proof.pub, proof.sig, banSnapshotCanonical(this.topic, proof)))) return false;
    if (this.banState?.sig === proof.sig) return true;
    this.banState = copyBanSnapshot(proof);
    for (const id of proof.bans) {
      this.bans.add(id); this.members.delete(id); delete this.typing[id]; this.voice.onMemberGone(id);
      for (const [wireId, rec] of [...this.wires]) if (rec.memberId === id) { rec.wire.destroy(); this.wires.delete(wireId); }
    }
    if (this.bans.has(this.identity.memberId)) {
      this.kicked = true; this.kickedBy = this.members.get(this.ownerId)?.name || ''; this.teardown();
    } else { await this.broadcast(this.helloMsg()); }
    this.onChange();
    return true;
  }

  private budget(rec: WireRec): RoomIngressBudget {
    let budget = this.wireIngress.get(rec);
    if (!budget) { budget = new RoomIngressBudget(); this.wireIngress.set(rec, budget); }
    return budget;
  }
  private async authenticate(msg: any, rec: WireRec): Promise<boolean> {
    const proofs = gossipProofs(msg, this.topic, this.transferChain[0]?.by || this.ownerPin || this.ownerId);
    if (!this.budget(rec).take(0, proofs.length * 2) || !this.ingress.take(0, proofs.length * 2)) return false;
    const identities = new Set(this.identities.keys());
    for (const p of proofs) {
      if (this.bans.has(p.memberId) && !p.chainLink || (await deriveMemberIdWeb(p.pub)) !== p.memberId) return false;
      const bound = this.identities.get(p.memberId);
      if (bound && bound !== p.pub) return false;
      identities.add(p.memberId);
      if (identities.size > ROOM_IDENTITY_LIMIT || !(await verifyWeb(p.pub, p.bytes, p.sig))) return false;
    }
    if ((msg.t === 'hello' || msg.t === 'ping') && msg.pub) {
      if ((await deriveMemberIdWeb(msg.pub)) !== msg.memberId || (this.identities.has(msg.memberId) && this.identities.get(msg.memberId) !== msg.pub)) return false;
      if (!this.identities.has(msg.memberId) && identities.size >= ROOM_IDENTITY_LIMIT) return false;
    }
    return true;
  }
  private onFrame(rec: WireRec, raw: string): Promise<void> {
    const operation = this.frameChain.then(() => this.processFrame(rec, raw));
    this.frameChain = operation.catch(() => {});
    return operation;
  }
  private async processFrame(rec: WireRec, raw: string): Promise<void> {
    if (this.kicked) return;
    if (raw.length > MAX_FRAME) return;
    const bytes = new TextEncoder().encode(raw).length;
    if (!this.budget(rec).take(bytes) || !this.ingress.take(bytes)) return;
    let msg: any;
    try { msg = validateGossip(await decryptWeb(this.key, raw)); } catch { return; }
    if (!msg || (msg._g && this.seen.has(msg._g))) return;
    if (!(await this.authenticate(msg, rec))) return;
    if (this.bans.has(msg.memberId) || this.bans.has(msg.by)) return;
    const direct = typeof msg._t !== 'number' || msg._t >= RELAY_TTL;
    if (msg.memberId && msg.memberId === this.identity.memberId) {
      if (direct) { rec.wire.destroy(); this.wires.delete(rec.id); }
      return;
    }
    if (msg.t === 'hello') {
      if (msg.transferChain && !ownerChainsCompatible(this.transferChain, msg.transferChain)) return;
      const proof = msg.banState;
      await this.adoptChain(msg.transferChain);
      if (msg.ownerId && !this.ownerId && (!this.ownerPin || msg.ownerId === this.ownerPin)) this.ownerId = String(msg.ownerId);
      if (proof && (proof.ownerId !== this.ownerId || !(await this.adoptBanState(proof)))) delete msg.banState;
      if (this.kicked) return;
      if (this.bans.has(msg.memberId)) {
        if (direct) { rec.wire.destroy(); this.wires.delete(rec.id); }
        return;
      }
    }
    if ((msg.t === 'hello' || msg.t === 'ping') && !this.members.has(msg.memberId) && this.members.size >= ROOM_MEMBER_LIMIT) return;
    if (['have', 'bye', 'typing', 'react-file', 'react-chat', 'prog'].includes(msg.t) && !this.members.has(msg.memberId)) return;
    if (msg.t === 'transfer' && !this.ownerId && (!this.ownerPin || this.ownerPin === msg.by)) this.ownerId = msg.by;
    if (msg.t === 'transfer' && this.ownerId && msg.by !== this.ownerId) return;
    if (msg.t === 'transfer' && msg.banState && (msg.banState.ownerId !== msg.by || msg.banState.bans.includes(msg.newOwnerId) || !(await this.adoptBanState(msg.banState)))) return;
    if (this.kicked) return;
    if (['rename', 'topic', 'rekey', 'kicked'].includes(msg.t) && (!this.ownerId || msg.by !== this.ownerId)) return;
    if (msg.t === 'del') {
      const file = this.files.get(msg.fileId);
      if (file && !canDeleteRoomFile(this.ownerId, file.addedBy, msg.memberId)) return;
    }
    if (['voice-state', 'voice-signal', 'voice-share'].includes(msg.t) && !this.members.has(msg.memberId)) return;
    if (['voice-state', 'voice-share'].includes(msg.t) && msg.at > Date.now() + 60_000) return;
    if (msg.t === 'voice-state') {
      if (this.voiceV2.has(msg.memberId) && msg.voiceV !== 2) return;
      if (msg.voiceV === 2) this.voiceV2.add(msg.memberId);
    }
    if (msg.t === 'hello' && msg.watchPolicy) {
      if (this.watchHost.accept(msg.watchPolicy, this.ownerId, Date.now(), this.transferAt)) { this.watchPolicyTopic = this.topic; this.onChange(); }
      else if (msg.watchPolicy.by !== this.ownerId) delete msg.watchPolicy;
    }
    if (msg.t === 'watch-policy-v1') {
      if (!this.watchHost.accept(msg, this.ownerId, Date.now(), this.transferAt)) return;
      this.watchPolicyTopic = this.topic; this.onChange();
    }
    if (msg.t === 'sync-v2') {
      if (!this.members.has(msg.memberId) || this.identities.get(msg.memberId) !== msg.pub || !this.files.has(msg.fileId)) return;
      if (!this.watchHost.allows(msg, this.ownerId, this.transferAt) || !this.watchReceiver.accept(msg)) return;
    }
    const gid = msg._g || '';
    // A different wire may have finished WebCrypto while this frame was awaiting.
    if (gid) {
      if (this.seen.has(gid)) return;
      this.markSeen(gid);
      await this.forward(msg, rec.id);
    }
    switch (msg.t) {
      case 'hello': {
        let assembly = direct ? this.directHelloAssemblies.get(rec) : this.helloAssembly;
        if (!assembly) { assembly = new RoomHelloAssembly(1, false); this.directHelloAssemblies.set(rec, assembly); }
        const sync = assembly.accept(msg);
        if (!sync.accepted) break;
        if (!this.members.has(msg.memberId) && this.members.size >= ROOM_MEMBER_LIMIT) break;
        if (direct) rec.memberId = msg.memberId;
        if (direct && !rec.greetedFull) {
          rec.greetedFull = true;
          void this.sendTo(rec, this.helloMsg(true));
        }
        if (msg.pub && !this.identities.has(msg.memberId) && this.identities.size < ROOM_IDENTITY_LIMIT) {
          this.identities.set(msg.memberId, String(msg.pub));
        }
        this.touch(msg.memberId, msg.name, msg.avatarSeed, msg.guest === true);
        this.members.get(msg.memberId)!.watchSync = msg.watchSync === 2;
        Object.assign(this.members.get(msg.memberId)!, readRoomCapabilities(msg));
        await this.adoptChain(msg.transferChain);
        if (msg.roomName && (!this.roomName || this.roomName === this.code)) {
          this.roomName = String(msg.roomName);
          const incoming = Math.min(Number(msg.nameAt) || 0, Date.now());
          if (incoming > this.nameAt) this.nameAt = incoming;
        }
        if (msg.ownerId && !this.ownerId) {
          if (!this.ownerPin || msg.ownerId === this.ownerPin) this.ownerId = String(msg.ownerId);
        }
        if (msg.e2e === true) this.e2e = true;
        if (msg.topicMsg) await this.applyTopic(msg.topicMsg);
        for (const f of msg.files || []) await this.adoptFile(f);
        for (const [id, p] of Object.entries(msg.tombSigs || {})) await this.acceptTomb(id, p as any);
        if (sync.first) this.voice.reannounce();
        await this.mergeHelloEdits(msg.chatEdits);
        this.mergeHelloReacts(msg.chatReacts);
        if (direct && (!msg.manifestPart || sync.complete)) await this.sendChatBackfill(rec, msg);
        this.onChange();
        break;
      }
      case 'ping': {
        if (!this.members.has(msg.memberId) && this.members.size >= ROOM_MEMBER_LIMIT) break;
        if (direct) rec.memberId = msg.memberId;
        this.touch(msg.memberId, msg.name, msg.avatarSeed, msg.guest === true);
        Object.assign(this.members.get(msg.memberId)!, readRoomCapabilities(msg));
        if (msg.watchSync === 2) this.members.get(msg.memberId)!.watchSync = true;
        if (msg.roomName && (!this.roomName || this.roomName === this.code)) this.roomName = String(msg.roomName);
        this.onChange();
        break;
      }
      case 'add':
        await this.adoptFile(msg.file);
        this.onChange();
        break;
      case 'transfer':
        await this.adoptChain([...this.transferChain, msg]);
        this.onChange();
        break;
      case 'del':
        await this.acceptTomb(msg.fileId, { at: msg.at, by: msg.memberId, pub: msg.pub, sig: msg.sig });
        this.onChange();
        break;
      case 'chat': {
        const cm = chatEnvelope(msg);
        if (!cm || !(await this.verifyChat(cm))) break;
        const m = this.members.get(cm.memberId);
        if (m) m.lastSeen = Date.now();
        this.addChat(cm);
        this.onChange();
        break;
      }
      case 'chat-log': {
        const list = Array.isArray(msg.msgs) ? msg.msgs.slice(0, MAX_CHAT) : [];
        for (const c of list) {
          const cm = chatEnvelope(c);
          if (!cm || this.bans.has(cm.memberId)) continue;
          const prior = this.chat.find(m => m.id === cm.id);
          if (prior && !upgradeChat(prior, cm)) continue;
          if (!(await this.verifyChat(cm))) continue;
          this.addChat(cm);
        }
        this.onChange();
        break;
      }
      case 'chat-edit': {
        const text = String(msg.text || '').slice(0, MAX_TEXT);
        const msgId = String(msg.msgId || '');
        const at = Number(msg.at) || 0;
        const memberId = String(msg.memberId || '');
        if (!text || !msgId || !validChatTime(at)) break;
        if (!(await this.verify(memberId, msg.pub, msg.sig, editCanonical(this.topic, { msgId, memberId, at, text })))) break;
        const target = this.chat.find((c) => c.id === msgId);
        if (target && target.memberId !== memberId) break;
        this.applyEdit(msgId, text, at, memberId, !!target, msg.pub, msg.sig);
        this.onChange();
        break;
      }
      case 'typing': {
        const m = this.members.get(msg.memberId);
        if (!m) break;
        m.lastSeen = Date.now();
        this.typing[msg.memberId] = Date.now();
        this.onChange();
        break;
      }
      case 'react-chat': {
        if (!REACT_SET.has(msg.emoji)) break;
        const mid = String(msg.msgId || '');
        const uid = String(msg.memberId || '');
        if (!mid || !uid) break;
        let byEmoji = this.chatReacts.get(mid);
        if (!byEmoji) { byEmoji = new Map(); this.chatReacts.set(mid, byEmoji); }
        let ids = byEmoji.get(msg.emoji);
        if (!ids) { ids = new Set(); byEmoji.set(msg.emoji, ids); }
        if (msg.on === true && ids.size < ROOM_MEMBER_LIMIT) ids.add(uid); else ids.delete(uid);
        while (this.chatReacts.size > ROOM_CHAT_LIMIT) this.chatReacts.delete(this.chatReacts.keys().next().value!);
        this.onChange();
        break;
      }
      case 'bye':
        this.members.delete(msg.memberId);
        this.voice.onMemberGone(msg.memberId);
        this.onChange();
        break;
      case 'rename':
        await this.applyRename(msg);
        break;
      case 'topic':
        await this.applyTopic(msg);
        this.onChange();
        break;
      case 'profile':
        await this.applyProfile(msg);
        break;
      case 'voice-state': {
        const at = Number(msg.at);
        if (!Number.isFinite(at) || at > Date.now() + 60_000) break;
        if (!(await this.verify(msg.memberId, msg.pub, msg.sig, voiceStateCanonical(this.topic, {
          memberId: msg.memberId, inVoice: !!msg.inVoice, muted: !!msg.muted, at,
        })))) break;
        this.voice.onPeerState(msg.memberId, !!msg.inVoice, !!msg.muted, at, msg.voiceV === 2 && msg.deafened === true);
        break;
      }
      case 'voice-signal': {
        if (msg.to !== this.identity.memberId) break;
        if (msg.kind !== 'offer' && msg.kind !== 'answer' && msg.kind !== 'ice') break;
        if (!(await this.verify(msg.memberId, msg.pub, msg.sig, voiceSignalCanonical(this.topic, {
          memberId: msg.memberId, to: msg.to, kind: msg.kind, data: msg.data,
        })))) break;
        this.voice.onSignal(msg.memberId, msg.kind as SignalKind, msg.data);
        break;
      }
      case 'watch-policy-v1': break;
      case 'sync-v2':
        if (!this.watchHost.allows(msg, this.ownerId, this.transferAt) || !this.watchReceiver.isCurrent(msg)) break;
        this.onSync?.({
          fileId: String(msg.fileId || ''),
          action: msg.action,
          ...(msg.v === 3 ? { v: 3, readiness: msg.readiness, requested: msg.requested, policyBy: msg.policyBy, policyAt: msg.policyAt, policyOwnerAt: msg.policyOwnerAt, hostSig: msg.hostSig } : {}),
          position: Number(msg.position) || 0,
          rate: Number(msg.rate) || 1,
          at: Number(msg.at) || Date.now(),
          sessionId: msg.sessionId, startedAt: msg.startedAt, seq: msg.seq,
          memberId: String(msg.memberId || ''),
          name: this.members.get(msg.memberId)!.name,
          avatarSeed: this.members.get(msg.memberId)!.avatarSeed,
          playing: !!msg.playing,
          together: msg.together,
          emoji: msg.emoji || '',
        });
        break;
      case 'kicked': {
        if (msg.targetId !== this.identity.memberId) break;
        if (!this.ownerId || msg.by !== this.ownerId) break;
        if (!(await this.verify(msg.by, msg.pub, msg.sig, kickedCanonical(this.topic, { targetId: msg.targetId, by: msg.by })))) break;
        this.kicked = true;
        this.kickedBy = String(msg.byName || '');
        this.teardown();
        break;
      }
      case 'rekey': {
        if (!this.ownerId || msg.by !== this.ownerId) break;
        if (!(await this.verify(msg.by, msg.pub, msg.sig, rekeyCanonical(this.topic, {
          newCode: msg.newCode, kickedId: msg.kickedId, by: msg.by,
        })))) break;
        if (msg.kickedId === this.identity.memberId) {
          this.kicked = true;
          this.kickedBy = String(msg.kickedName || '');
          this.teardown();
          break;
        }
        this.bans.add(String(msg.kickedId));
        this.members.delete(msg.kickedId);
        this.voice.onMemberGone(String(msg.kickedId));
        for (const [id, rec] of this.wires) {
          if (rec.memberId === msg.kickedId) { rec.wire.destroy(); this.wires.delete(id); }
        }
        await this.rotate(String(msg.newCode));
        break;
      }
      default:
        break;
    }
  }

  private async rotate(newCode: string): Promise<void> {
    if (newCode === this.code) return;
    this.helloOutbox.stop(); this.helloOutbox = new RoomHelloOutbox(); this.helloAssembly.clear();
    this.pendingEdits.clear(); this.pendingTombs.clear();
    this.banState = null;
    this.code = newCode;
    this.e2e = codeIsE2E(newCode);
    this.key = await deriveKeyWeb(newCode);
    this.topic = await topicHashWeb(newCode);
    this.rendezvous = await rendezvousIdWeb(this.key);
    this.rv?.stop();
    this.rv = startRendezvous({
      infoHashHex: this.rendezvous,
      peerIdHex: randomHex(20),
      announce: this.trackers,
      iceServers: this.ice,
      onPeer: (wire) => this.attach(wire),
    });
    this.onChange();
  }

  private applyEdit(msgId: string, text: string, at: number, memberId: string, haveTarget: boolean, pub: string, sig: string): void {
    if (!haveTarget) {
      const cur = this.pendingEdits.get(msgId);
      if (cur && (cur.at > at || (cur.at === at && cur.sig >= sig))) return;
      this.pendingEdits.set(msgId, { text, at, memberId, pub, sig });
      while (this.pendingEdits.size > MAX_CHAT) this.pendingEdits.delete(this.pendingEdits.keys().next().value!);
      return;
    }
    const cur = this.chatEdits.get(msgId);
    if (cur && (cur.at > at || (cur.at === at && cur.sig >= sig))) return;
    this.chatEditTopics.set(msgId, this.topic);
    this.chatEdits.set(msgId, { text, at, by: memberId, pub, sig });
  }

  private flushPendingEdit(msgId: string): void {
    const pend = this.pendingEdits.get(msgId);
    if (!pend) return;
    this.pendingEdits.delete(msgId);
    const target = this.chat.find((c) => c.id === msgId);
    if (!target || target.memberId !== pend.memberId) return;
    this.applyEdit(msgId, pend.text, pend.at, pend.memberId, true, pend.pub, pend.sig);
  }

  private async mergeHelloEdits(rec: unknown): Promise<void> {
    if (!rec || typeof rec !== 'object') return;
    for (const [msgId, raw] of Object.entries(rec as Record<string, any>).slice(0, MAX_CHAT)) {
      const text = String(raw?.text || '').slice(0, MAX_TEXT);
      const at = Number(raw?.at) || 0;
      const memberId = String(raw?.by || '');
      if (!msgId || !text || !memberId || !validChatTime(at)) continue;
      if (!(await this.verify(memberId, raw.pub, raw.sig, editCanonical(this.topic, { msgId, memberId, at, text })))) continue;
      const target = this.chat.find((c) => c.id === msgId);
      if (target && target.memberId !== memberId) continue;
      this.applyEdit(msgId, text, at, memberId, !!target, raw.pub, raw.sig);
    }
  }

  private mergeHelloReacts(rec: unknown): void {
    if (!rec || typeof rec !== 'object') return;
    for (const [msgId, byEmoji] of Object.entries(rec as Record<string, Record<string, string[]>>)) {
      if (!msgId || !byEmoji || typeof byEmoji !== 'object') continue;
      let map = this.chatReacts.get(msgId);
      if (!map) { map = new Map(); this.chatReacts.set(msgId, map); }
      for (const [em, ids] of Object.entries(byEmoji)) {
        if (!REACT_SET.has(em) || !Array.isArray(ids)) continue;
        let set = map.get(em);
        if (!set) { set = new Set(); map.set(em, set); }
        for (const id of ids) if (typeof id === 'string' && id && set.size < ROOM_MEMBER_LIMIT) set.add(id);
        while (this.chatReacts.size > ROOM_CHAT_LIMIT) this.chatReacts.delete(this.chatReacts.keys().next().value!);
      }
    }
  }

  private async verifyChat(msg: GuestChat): Promise<boolean> {
    return await this.verify(msg.memberId, msg.pub!, msg.sig!, chatCanonical(this.topic, msg))
      && (msg.chatV !== 2 || await this.verify(msg.memberId, msg.pub!, msg.contextSig!, chatContextCanonical(this.topic, msg)));
  }

  private addChat(msg: GuestChat): void {
    const index = this.chat.findIndex(m => m.id === msg.id);
    if (index >= 0) {
      const upgrade = upgradeChat(this.chat[index], msg);
      if (upgrade) this.chat[index] = upgrade;
      return;
    }
    const overflowing = this.chat.length >= MAX_CHAT;
    this.chat = retainRoomChat([...this.chat, { ...msg, receivedAt: Date.now() }]);
    this.flushPendingEdit(msg.id);
    if (!overflowing) return;
    const kept = new Set(this.chat.map(m => m.id));
    for (const id of this.chatEdits.keys()) if (!kept.has(id)) { this.chatEdits.delete(id); this.chatEditTopics.delete(id); }
    for (const id of this.chatReacts.keys()) if (!kept.has(id)) this.chatReacts.delete(id);
  }

  private async sendChatBackfill(rec: WireRec, hello: { chatSync?: number; chatIds?: string[] }): Promise<void> {
    if (hello.chatSync === 2 && !Array.isArray(hello.chatIds)) return;
    if (hello.chatSync !== 2 && rec.legacyChatSent) return;
    const pages = chatBackfillPages(this.chat, hello.chatSync === 2 ? hello.chatIds : undefined);
    const work = pages.reduce((sum, page) => sum + page.length * 2, 0);
    if (!this.budget(rec).take(0, work) || !this.ingress.take(0, work)) return;
    if (hello.chatSync !== 2) rec.legacyChatSent = true;
    for (const page of pages) {
      const msgs = [];
      for (const m of page) if (!this.bans.has(m.memberId) && await this.verifyChat(m)) msgs.push(m);
      if (msgs.length) await this.sendTo(rec, { t: 'chat-log', msgs });
    }
  }

  private async applyRename(msg: any): Promise<void> {
    const at = Number(msg.at) || 0;
    const name = String(msg.name || '').slice(0, MAX_STR).trim();
    const by = String(msg.by || '');
    if (!name || at <= this.nameAt || at > Date.now() + 60_000) return;
    if (!this.ownerId || by !== this.ownerId) return;
    if (!(await this.verify(by, msg.pub, msg.sig, renameCanonical(this.topic, { name, at, by })))) return;
    this.roomName = name;
    this.nameAt = at;
    this.onChange();
  }

  private async applyTopic(msg: any): Promise<boolean> {
    const at = Number(msg.at) || 0;
    const text = String(msg.text ?? '').slice(0, MAX_TOPIC).trim();
    const by = String(msg.by || '');
    if (at <= this.topicAt || at > Date.now() + 60_000) return false;
    if (!this.ownerId || by !== this.ownerId) return false;
    if (!(await this.verify(by, msg.pub, msg.sig, topicCanonical(this.topic, { text, at, by })))) return false;
    this.topicText = text;
    this.topicAt = at;
    return true;
  }

  private async applyProfile(msg: GossipMessage): Promise<void> {
    const at = Number(msg.at);
    if (!Number.isFinite(at) || at > Date.now() + 60_000) return;
    const memberId = String(msg.memberId || '');
    const prev = this.profileAt.get(memberId) || 0;
    if (!memberId || prev >= at) return;
    const body = {
      memberId, at,
      name: String(msg.name || ''),
      avatarSeed: String(msg.avatarSeed || ''),
      color: String(msg.color || ''),
      status: String(msg.status || ''),
      img: String(msg.img || ''),
    };
    if (!(await this.verify(memberId, msg.pub, msg.sig, profileCanonical(this.topic, body)))) return;
    this.profileAt.set(memberId, at);
    this.touch(memberId, body.name, body.avatarSeed);
    this.onChange();
  }

  private async sendVoiceState(inVoice: boolean, muted: boolean, at: number, deafened?: boolean): Promise<void> {
    const sig = await signWeb(this.identity.priv, voiceStateCanonical(this.topic, {
      memberId: this.identity.memberId, inVoice, muted, at,
    }));
    const stateSig = await signWeb(this.identity.priv, voiceStateV2Canonical(this.topic, { memberId: this.identity.memberId, inVoice, muted, at, deafened: deafened === true }));
    await this.broadcast({
      voiceV: 2, stateSig, t: 'voice-state', memberId: this.identity.memberId, inVoice, muted,
      deafened: deafened === true, at, pub: this.identity.pub, sig,
    });
  }

  private async sendVoiceSignal(to: string, kind: SignalKind, data: unknown): Promise<void> {
    const sig = await signWeb(this.identity.priv, voiceSignalCanonical(this.topic, {
      memberId: this.identity.memberId, to, kind, data,
    }));
    await this.broadcast({
      t: 'voice-signal', memberId: this.identity.memberId, to, kind, data,
      pub: this.identity.pub, sig,
    });
  }
}

export type { GuestIdentity };
