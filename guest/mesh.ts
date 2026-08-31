/**
 * Browser guest mesh — announce, gossip, chat, voice signaling, watch-sync.
 * Relays the same RELAYABLE set as the desktop engine so a guest can still
 * help a NAT pair (and so LAN/server frames keep flowing through them).
 */

import { parseInvite, codeIsE2E } from '../shared/room-invite';
import {
  chatCanonical, editCanonical, voiceStateCanonical, voiceSignalCanonical,
  rekeyCanonical, kickedCanonical, renameCanonical, topicCanonical, profileCanonical,
} from '../shared/room-canonicals';
import { CHAT_REACT_EMOJIS } from '../shared/reactions';
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
const MAX_CHAT = 200;
const MAX_TOPIC = 300;
const TYPING_TTL = 4000;
const TYPING_MIN = 2000;
const REACT_SET = new Set<string>(CHAT_REACT_EMOJIS);

const RELAYABLE = new Set([
  'hello', 'ping', 'add', 'have', 'del', 'chat', 'chat-edit', 'sync', 'bye',
  'typing', 'react-file', 'prog', 'folder', 'assign', 'rename', 'topic',
  'react-chat', 'voice-state', 'voice-signal', 'voice-share', 'profile',
  'transfer', 'lan-genesis', 'lan-state', 'lan-signal', 'lan-admit',
  'lan-evict', 'lan-reach', 'srv-mirror', 'srv-cmd',
]);

function clampStr(v: unknown, n: number): string {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

function clampGossip(msg: any): void {
  if ('memberId' in msg) msg.memberId = clampStr(msg.memberId, MAX_STR);
  if ('name' in msg) msg.name = clampStr(msg.name, MAX_STR);
  if ('roomName' in msg) msg.roomName = clampStr(msg.roomName, MAX_STR);
  if ('avatarSeed' in msg) msg.avatarSeed = clampStr(msg.avatarSeed, MAX_STR);
  if ('ownerId' in msg) msg.ownerId = clampStr(msg.ownerId, MAX_STR);
  if ('by' in msg) msg.by = clampStr(msg.by, MAX_STR);
  if ('to' in msg) msg.to = clampStr(msg.to, MAX_STR);
  if ('kind' in msg) msg.kind = clampStr(msg.kind, 16);
  if ('fileId' in msg) msg.fileId = clampStr(msg.fileId, MAX_STR);
  if ('msgId' in msg) msg.msgId = clampStr(msg.msgId, MAX_STR);
  if ('text' in msg) msg.text = clampStr(msg.text, MAX_TEXT);
  if ('emoji' in msg) msg.emoji = clampStr(msg.emoji, 16);
  if ('pub' in msg) msg.pub = clampStr(msg.pub, MAX_STR * 2);
  if ('sig' in msg) msg.sig = clampStr(msg.sig, MAX_STR);
  if ('replyTo' in msg) msg.replyTo = clampStr(msg.replyTo, MAX_STR);
  if ('replyName' in msg) msg.replyName = clampStr(msg.replyName, MAX_STR);
  if ('replyText' in msg) msg.replyText = clampStr(msg.replyText, MAX_TEXT);
  if (msg.t === 'hello' || msg.t === 'ping') msg.guest = msg.guest === true;
}

export interface GuestMember {
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
}

export interface GuestChat {
  id: string;
  at: number;
  memberId: string;
  name: string;
  avatarSeed: string;
  text: string;
  replyTo?: string;
  replyName?: string;
  replyText?: string;
  pub?: string;
  sig?: string;
}

export interface GuestFile {
  fileId: string;
  name: string;
  size: number;
  magnetURI: string;
  enc?: boolean;
  playable: boolean;
}

export interface SyncEvent {
  fileId: string;
  action: string;
  position: number;
  rate: number;
  at: number;
  memberId: string;
  name: string;
  avatarSeed: string;
  playing: boolean;
  together?: boolean;
  emoji?: string;
}

export interface GuestSnapshot {
  roomName: string;
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
  voice: { inVoice: boolean; muted: boolean; deafened: boolean; participants: VoiceParticipant[] };
}

interface WireRec { id: number; wire: DataWire; memberId?: string; greetedFull?: boolean }

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
  private topic = '';
  private rendezvous = '';
  private code = '';
  private ice: RTCIceServer[];
  private trackers: string[];
  private rv: { stop: () => void } | null = null;
  private wires = new Map<number, WireRec>();
  private wireSeq = 0;
  private members = new Map<string, GuestMember>();
  private identities = new Map<string, string>();
  private chat: GuestChat[] = [];
  private chatEdits = new Map<string, { text: string; at: number }>();
  private pendingEdits = new Map<string, { text: string; at: number; memberId: string }>();
  private chatReacts = new Map<string, Map<string, Set<string>>>();
  private profileAt = new Map<string, number>();
  private files = new Map<string, GuestFile>();
  private typing: Record<string, number> = {};
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private bans = new Set<string>();
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

  private torn = false;

  private teardown(): void {
    if (this.torn) return;
    this.torn = true;
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
      role: this.ownerId === this.identity.memberId ? 'owner' : 'member',
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
      const parent = this.chat.find((c) => c.id === replyTo);
      if (parent) {
        msg.replyTo = parent.id;
        msg.replyName = parent.name;
        msg.replyText = (this.chatEdits.get(parent.id)?.text ?? parent.text).slice(0, 140);
      }
    }
    const sig = await signWeb(this.identity.priv, chatCanonical(this.topic, msg));
    msg.pub = this.identity.pub;
    msg.sig = sig;
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat = this.chat.slice(-MAX_CHAT);
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

  async sendSync(ev: Omit<SyncEvent, 'memberId' | 'name' | 'avatarSeed'> & { memberId?: string }): Promise<void> {
    await this.broadcast({
      t: 'sync',
      fileId: ev.fileId,
      action: ev.action,
      position: ev.position,
      rate: ev.rate ?? 1,
      at: ev.at || Date.now(),
      memberId: this.identity.memberId,
      name: this.name,
      avatarSeed: this.avatarSeed,
      playing: !!ev.playing,
      together: ev.together,
      emoji: ev.emoji,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private helloMsg(full = true): Record<string, unknown> {
    const m: Record<string, unknown> = {
      t: 'hello',
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
    };
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
    };
  }

  private attach(wire: DataWire): void {
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
    wire.onData((raw) => { void this.onFrame(rec, raw); });
    wire.onClose(() => { this.wires.delete(rec.id); this.onChange(); });
    this.onChange();
  }

  private async sendTo(rec: WireRec, msg: Record<string, unknown>): Promise<void> {
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
    const token = await encryptWeb(this.key, msg);
    for (const rec of this.wires.values()) {
      if (rec.id === fromId) continue;
      if (!rec.memberId || this.bans.has(rec.memberId)) continue;
      try { rec.wire.send(token); } catch { /* ignore */ }
    }
  }

  private async verify(memberId: string, pub: string, sig: string, bytes: Uint8Array): Promise<boolean> {
    if (!memberId || !pub || !sig) return false;
    if (await deriveMemberIdWeb(pub) !== memberId) return false;
    const bound = this.identities.get(memberId);
    if (bound && bound !== pub) return false;
    if (!(await verifyWeb(pub, bytes, sig))) return false;
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

  private adoptFile(f: any): void {
    const fileId = clampStr(f?.fileId, MAX_STR);
    const magnetURI = clampStr(f?.magnetURI, 4096);
    const name = clampStr(f?.name, MAX_STR);
    if (!fileId || !magnetURI || !name) return;
    this.files.set(fileId, {
      fileId, name, magnetURI,
      size: Number.isFinite(f.size) ? f.size : 0,
      enc: f.enc === true,
      playable: f.enc !== true && classifyMediaKind(name) !== 'other' && isDirectlyPlayable(name),
    });
  }

  private async onFrame(rec: WireRec, raw: string): Promise<void> {
    if (raw.length > MAX_FRAME) return;
    let msg: any;
    try { msg = await decryptWeb(this.key, raw); } catch { return; }
    clampGossip(msg);
    if (this.bans.has(msg.memberId) || this.bans.has(msg.by)) return;
    const direct = typeof msg._t !== 'number' || msg._t >= RELAY_TTL;
    if (msg.memberId && msg.memberId === this.identity.memberId) {
      if (direct) { rec.wire.destroy(); this.wires.delete(rec.id); }
      return;
    }
    const gid = String(msg._g || '');
    if (gid) {
      if (this.seen.has(gid)) return;
      this.markSeen(gid);
      await this.forward(msg, rec.id);
    }
    switch (msg.t) {
      case 'hello': {
        if (direct) rec.memberId = msg.memberId;
        if (direct && !rec.greetedFull) {
          rec.greetedFull = true;
          void this.sendTo(rec, this.helloMsg(true));
        }
        if (msg.pub && (await deriveMemberIdWeb(String(msg.pub))) === msg.memberId) {
          this.identities.set(msg.memberId, String(msg.pub));
        }
        this.touch(msg.memberId, msg.name, msg.avatarSeed, msg.guest === true);
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
        for (const f of msg.files || []) this.adoptFile(f);
        await this.mergeHelloEdits(msg.chatEdits);
        this.mergeHelloReacts(msg.chatReacts);
        if (direct) void this.sendChatBackfill(rec, Number(msg.chatAt) || 0);
        this.onChange();
        break;
      }
      case 'ping': {
        if (direct) rec.memberId = msg.memberId;
        this.touch(msg.memberId, msg.name, msg.avatarSeed, msg.guest === true);
        if (msg.roomName && (!this.roomName || this.roomName === this.code)) this.roomName = String(msg.roomName);
        this.onChange();
        break;
      }
      case 'add':
        this.adoptFile(msg.file);
        this.onChange();
        break;
      case 'del':
        if (msg.fileId) this.files.delete(String(msg.fileId));
        this.onChange();
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, MAX_TEXT);
        const id = String(msg.id || '');
        const memberId = String(msg.memberId || '');
        const at = Number(msg.at) || 0;
        if (!id || !text || !memberId || this.chat.some((c) => c.id === id)) break;
        if (at > Date.now() + 60_000) break;
        if (!(await this.verify(memberId, msg.pub, msg.sig, chatCanonical(this.topic, { id, at, memberId, text })))) break;
        const m = this.members.get(memberId);
        if (m) m.lastSeen = Date.now();
        this.chat.push({
          id, at, memberId, text,
          name: msg.name || '?',
          avatarSeed: msg.avatarSeed || memberId,
          replyTo: msg.replyTo, replyName: msg.replyName, replyText: msg.replyText,
          pub: msg.pub, sig: msg.sig,
        });
        if (this.chat.length > MAX_CHAT) this.chat = this.chat.slice(-MAX_CHAT);
        this.flushPendingEdit(id);
        this.onChange();
        break;
      }
      case 'chat-log': {
        const list = Array.isArray(msg.msgs) ? msg.msgs.slice(0, MAX_CHAT) : [];
        for (const c of list) {
          const text = String(c?.text || '').slice(0, MAX_TEXT);
          const memberId = String(c?.memberId || '');
          const id = String(c?.id || '');
          const at = Number(c?.at) || 0;
          if (!id || !text || !memberId || this.chat.some((x) => x.id === id)) continue;
          if (at > Date.now() + 60_000) continue;
          if (!(await this.verify(memberId, c.pub, c.sig, chatCanonical(this.topic, { id, at, memberId, text })))) continue;
          this.chat.push({
            id, at, memberId, text, name: c.name || '?', avatarSeed: c.avatarSeed || memberId,
            pub: c.pub, sig: c.sig,
          });
          this.flushPendingEdit(id);
        }
        this.chat.sort((a, b) => a.at - b.at);
        if (this.chat.length > MAX_CHAT) this.chat = this.chat.slice(-MAX_CHAT);
        this.onChange();
        break;
      }
      case 'chat-edit': {
        const text = String(msg.text || '').slice(0, MAX_TEXT);
        const msgId = String(msg.msgId || '');
        const at = Number(msg.at) || 0;
        const memberId = String(msg.memberId || '');
        if (!text || !msgId) break;
        if (!(await this.verify(memberId, msg.pub, msg.sig, editCanonical(this.topic, { msgId, memberId, at, text })))) break;
        const target = this.chat.find((c) => c.id === msgId);
        if (target && target.memberId !== memberId) break;
        this.applyEdit(msgId, text, at, memberId, !!target);
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
        if (msg.on === true) ids.add(uid); else ids.delete(uid);
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
        this.voice.onPeerState(msg.memberId, !!msg.inVoice, !!msg.muted, at, msg.deafened === true);
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
      case 'sync':
        this.onSync?.({
          fileId: String(msg.fileId || ''),
          action: String(msg.action || ''),
          position: Number(msg.position) || 0,
          rate: Number(msg.rate) || 1,
          at: Number(msg.at) || Date.now(),
          memberId: String(msg.memberId || ''),
          name: String(msg.name || '?'),
          avatarSeed: String(msg.avatarSeed || ''),
          playing: !!msg.playing,
          together: msg.together,
          emoji: msg.emoji,
        });
        break;
      case 'kicked': {
        if (msg.targetId !== this.identity.memberId) break;
        if (this.ownerId && msg.by !== this.ownerId) break;
        if (!(await this.verify(msg.by, msg.pub, msg.sig, kickedCanonical(this.topic, { targetId: msg.targetId, by: msg.by })))) break;
        this.kicked = true;
        this.kickedBy = String(msg.byName || '');
        this.teardown();
        break;
      }
      case 'rekey': {
        if (this.ownerId && msg.by !== this.ownerId) break;
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

  private applyEdit(msgId: string, text: string, at: number, memberId: string, haveTarget: boolean): void {
    if (!haveTarget) {
      const cur = this.pendingEdits.get(msgId);
      if (cur && cur.at >= at) return;
      this.pendingEdits.set(msgId, { text, at, memberId });
      return;
    }
    const cur = this.chatEdits.get(msgId);
    if (cur && cur.at >= at) return;
    this.chatEdits.set(msgId, { text, at });
  }

  private flushPendingEdit(msgId: string): void {
    const pend = this.pendingEdits.get(msgId);
    if (!pend) return;
    this.pendingEdits.delete(msgId);
    const target = this.chat.find((c) => c.id === msgId);
    if (!target || target.memberId !== pend.memberId) return;
    this.applyEdit(msgId, pend.text, pend.at, pend.memberId, true);
  }

  private async mergeHelloEdits(rec: unknown): Promise<void> {
    if (!rec || typeof rec !== 'object') return;
    for (const [msgId, raw] of Object.entries(rec as Record<string, any>)) {
      const text = String(raw?.text || '').slice(0, MAX_TEXT);
      const at = Number(raw?.at) || 0;
      const memberId = String(raw?.by || '');
      if (!msgId || !text || !memberId) continue;
      if (!(await this.verify(memberId, raw.pub, raw.sig, editCanonical(this.topic, { msgId, memberId, at, text })))) continue;
      const target = this.chat.find((c) => c.id === msgId);
      if (target && target.memberId !== memberId) continue;
      this.applyEdit(msgId, text, at, memberId, !!target);
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
        for (const id of ids) if (typeof id === 'string' && id) set.add(id);
      }
    }
  }

  private async sendChatBackfill(rec: WireRec, since: number): Promise<void> {
    const msgs = this.chat
      .filter((m) => m.at > since && m.pub && m.sig)
      .slice(-100)
      .map((m) => ({
        id: m.id, memberId: m.memberId, name: m.name, avatarSeed: m.avatarSeed,
        text: m.text, at: m.at, pub: m.pub, sig: m.sig,
      }));
    if (msgs.length) await this.sendTo(rec, { t: 'chat-log', msgs });
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

  private async applyProfile(msg: any): Promise<void> {
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
    await this.broadcast({
      t: 'voice-state', memberId: this.identity.memberId, inVoice, muted,
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
