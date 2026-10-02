import { validCommandRequest, validCommandId } from './server-command';
import { validManifestPart } from './room-manifest-sync';
import { chatEnvelope, validChatTime, ROOM_CHAT_LIMIT } from './room-chat-history';
import { CHAT_REACT_EMOJIS } from './reactions';
import { validWatchMessage } from './room-watch-sync';
import { validWatchPolicy } from './room-watch-host';
import { MAX_LAN_REACH } from './lan-types';
import { sanitizeProfileImg, PROFILE_COLOR_RE } from './profile';
import { validRoomCapabilities } from './room-capabilities';
import { validBanSnapshot } from './room-bans';
import { validKeyMetadata, validKeyPage, ROOM_KEY_PAGE_LIMIT } from './room-keyring';

export const ROOM_FRAME_LIMIT = 1_000_000;
export const ROOM_MEMBER_LIMIT = 256;
export const ROOM_WIRE_LIMIT = 64;
export const ROOM_IDENTITY_LIMIT = 2048;
export const ROOM_RELAY_TYPES = new Set(['hello', 'ping', 'add', 'have', 'del', 'chat', 'chat-edit',
  'e2e-keys', 'e2e-key-request', 'sync-v2', 'watch-policy-v1', 'bye', 'typing', 'react-file', 'prog', 'folder', 'assign', 'rename', 'topic',
  'react-chat', 'voice-state', 'voice-signal', 'voice-share', 'profile', 'transfer',
  'lan-genesis', 'lan-state', 'lan-signal', 'lan-admit', 'lan-evict', 'lan-reach', 'srv-mirror', 'srv-cmd', 'srv-cmd-v2', 'srv-result-v2']);
const TYPES = new Set([...ROOM_RELAY_TYPES, 'sync', 'chat-log', 'rekey', 'kicked']);
// Dynamic shape is confined to this boundary; consumers still use their discriminated unions.
export type GossipMessage = Record<string, any> & { t: string };
const obj = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: any, max = 1024, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.length > 0);
const opt = (v: any, check: (v: any) => boolean) => v === undefined || check(v);
const bool = (v: any) => typeof v === 'boolean';
const num = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const list = (v: any, max: number, check: (v: any) => boolean) => Array.isArray(v) && v.length <= max && v.every(check);
const record = (v: any, max: number, check: (v: any) => boolean) => obj(v) && Object.keys(v).length <= max && Object.values(v).every(check);
const proof = (v: any) => obj(v) && str(v.pub, 2048) && str(v.sig) && validChatTime(v.at);
const edit = (v: any) => proof(v) && str(v.by) && str(v.text, 2000);
const folder = (v: any) => obj(v) && str(v.id) && str(v.name, 1024, true) && validChatTime(v.at)
  && opt(v.icon, x => str(x, 64, true)) && opt(v.color, x => str(x, 64, true)) && opt(v.parentId, x => str(x, 1024, true));
const file = (v: any) => obj(v) && str(v.fileId) && str(v.name) && num(v.size) && Number.isSafeInteger(v.size) && str(v.infoHash)
  && str(v.magnetURI, 4096) && str(v.addedBy) && str(v.addedByName, 1024, true) && validChatTime(v.addedAt)
  && opt(v.keyEpoch, x => v.enc === true && typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) && opt(v.enc, bool) && opt(v.folderId, x => str(x, 1024, true)) && opt(v.folderAt, validChatTime)
  && (v.revBy === undefined && v.revAt === undefined && v.revPub === undefined && v.revSig === undefined
    || str(v.revBy) && validChatTime(v.revAt) && str(v.revPub, 2048) && str(v.revSig));
const transfer = (v: any) => proof(v) && str(v.by) && str(v.newOwnerId);
const reacts = (v: any) => record(v, 200, r => record(r, 16, ids => list(ids, ROOM_MEMBER_LIMIT, x => str(x))));
const chat = (v: any) => !!chatEnvelope(v) && str(v.pub, 2048) && str(v.sig)
  && opt(v.name, x => str(x, 1024, true)) && opt(v.avatarSeed, x => str(x, 1024, true));

/** Depth/node budgets also cover extension fields, before expensive signature work. */
function boundedJson(root: unknown): boolean {
  let nodes = 0;
  const walk = (v: any, depth: number): boolean => {
    if (++nodes > 80_000 || depth > 12) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= 200_000;
    if (Array.isArray(v)) return v.length <= 5000 && v.every(x => walk(x, depth + 1));
    return obj(v) && Object.keys(v).length <= 5000 && Object.entries(v).every(([k, x]) =>
      k.length <= 1024 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && walk(x, depth + 1));
  };
  return walk(root, 0);
}

/** Validate, never repair signed bytes. Null / scalar / unknown types are ordinary rejected frames. */
export function validateGossip(value: unknown): GossipMessage | null {
  try {
    if (!obj(value) || !TYPES.has(value.t) || !boundedJson(value)) return null;
    const m = value;
    if (!opt(m._g, x => str(x, 128)) || !opt(m._t, x => Number.isInteger(x) && x >= 1 && x <= 4)) return null;
    for (const key of ['memberId', 'by', 'to', 'fileId', 'msgId', 'sessionId', 'member', 'hostId', 'instanceId', 'newOwnerId', 'targetId', 'kickedId']) {
      if (!opt(m[key], x => str(x, 1024, m.t === 'watch-policy-v1' && key === 'hostId'))) return null;
    }
    for (const key of ['name', 'avatarSeed', 'roomName', 'ownerId', 'byName', 'kickedName']) {
      if (!opt(m[key], x => str(x, 1024, true))) return null;
    }
    if (!opt(m.pub, x => str(x, 2048, true)) || !opt(m.sig, x => str(x)) || !opt(m.at, validChatTime)) return null;
    let ok = false;
    switch (m.t) {
      case 'hello': case 'ping':
        ok = str(m.memberId) && validRoomCapabilities(m) && opt(m.have, x => list(x, 5000, y => str(y))) && opt(m.guest, bool)
          && opt(m.manifestFull, bool) && opt(m.manifestPart, validManifestPart) && opt(m.manifestRequest, bool) && opt(m.watchSync, x => x === 2) && opt(m.chatSync, x => x === 2) && opt(m.chatAt, validChatTime)
          && opt(m.chatIds, x => list(x, ROOM_CHAT_LIMIT, y => str(y, 128)))
          && opt(m.nameAt, validChatTime) && opt(m.e2e, bool) && opt(m.secret, x => str(x, 256, true))
          && opt(m.banState, validBanSnapshot) && opt(m.files, x => list(x, 5000, file)) && opt(m.tombs, x => list(x, 5000, y => str(y)))
          && opt(m.watchPolicy, validWatchPolicy)
          && opt(m.tombsAt, x => record(x, 5000, validChatTime))
          && opt(m.tombSigs, x => record(x, 500, y => proof(y) && str(y.by)))
          && opt(m.chatEdits, x => record(x, ROOM_CHAT_LIMIT, edit))
          && opt(m.topicMsg, x => proof(x) && str(x.by) && str(x.text, 300, true))
          && opt(m.folders, x => list(x, 5000, folder)) && opt(m.folderTombs, x => record(x, 5000, validChatTime))
          && opt(m.fileReacts, reacts) && opt(m.chatReacts, reacts) && opt(m.transferChain, x => list(x, 8, transfer))
          && opt(m.cfg, c => obj(c) && str(c.ownerId) && bool(c.e2e) && str(c.secret, 256, true) && str(c.pub, 2048) && str(c.sig)
            && opt(c.keys, validKeyMetadata) && (c.prevSecrets === undefined && c.prevSig === undefined || list(c.prevSecrets, 8, x => str(x, 256)) && str(c.prevSig)));
        break;
      case 'e2e-keys': ok = str(m.ownerId) && str(m.pub, 2048) && str(m.sig) && validKeyPage(m as any); break;
      case 'e2e-key-request': ok = str(m.memberId) && typeof m.root === 'string' && /^[a-f0-9]{64}$/.test(m.root)
        && Number.isInteger(m.page) && m.page >= 0 && m.page < ROOM_KEY_PAGE_LIMIT; break;
      case 'add': ok = file(m.file); break;
      case 'chat': ok = chat(m); break;
      case 'chat-log': ok = list(m.msgs, ROOM_CHAT_LIMIT, chat); break;
      case 'chat-edit': ok = proof(m) && str(m.msgId) && str(m.memberId) && str(m.text, 2000); break;
      case 'sync-v2': ok = validWatchMessage(m) && str(m.memberId) && str(m.pub, 2048) && str(m.sig); break;
      case 'watch-policy-v1': ok = validWatchPolicy(m); break;
      case 'sync': return null; // Unsigned legacy playback must never control a v2 viewer.
      case 'have': ok = str(m.memberId) && str(m.fileId); break;
      case 'bye': case 'typing': ok = str(m.memberId); break;
      case 'prog': ok = str(m.memberId) && str(m.fileId) && num(m.pct) && m.pct <= 100; break;
      case 'react-file': case 'react-chat': ok = str(m.memberId) && str(m.t === 'react-file' ? m.fileId : m.msgId)
        && (m.t === 'react-chat' ? [...CHAT_REACT_EMOJIS] : ['🔥', '👍', '❤️', '😂']).includes(m.emoji) && bool(m.on); break;
      case 'folder': ok = str(m.memberId) && str(m.id) && validChatTime(m.at) && ['upsert', 'del'].includes(m.op)
        && (m.op === 'del' || folder(m)); break;
      case 'assign': ok = str(m.memberId) && str(m.fileId) && str(m.folderId, 1024, true) && validChatTime(m.at); break;
      case 'del': ok = proof(m) && str(m.fileId) && str(m.memberId); break;
      case 'rename': case 'topic': ok = proof(m) && str(m.by) && str(m.t === 'rename' ? m.name : m.text, m.t === 'rename' ? 1024 : 300, true); break;
      case 'transfer': ok = transfer(m) && opt(m.banState, validBanSnapshot); break;
      case 'rekey': ok = str(m.by) && str(m.pub, 2048) && str(m.sig) && str(m.newCode, 256) && str(m.kickedId); break;
      case 'kicked': ok = str(m.by) && str(m.pub, 2048) && str(m.sig) && str(m.targetId); break;
      case 'profile': ok = proof(m) && str(m.memberId) && str(m.name, 1024, true) && str(m.avatarSeed, 1024, true)
        && str(m.status, 140, true) && str(m.img, 64000, true) && sanitizeProfileImg(m.img) === m.img
        && (m.color === '' || typeof m.color === 'string' && PROFILE_COLOR_RE.test(m.color)); break;
      case 'voice-state': ok = proof(m) && str(m.memberId) && bool(m.inVoice) && bool(m.muted) && opt(m.deafened, bool)
        && (m.voiceV === undefined && m.stateSig === undefined || m.voiceV === 2 && bool(m.deafened) && str(m.stateSig)); break;
      case 'voice-share': ok = proof(m) && str(m.memberId) && bool(m.sharing) && str(m.streamId, 1024, true); break;
      case 'voice-signal': case 'lan-signal': ok = str(m.memberId) && str(m.to) && str(m.pub, 2048) && str(m.sig)
        && (['offer', 'answer', 'ice'].includes(m.kind) || m.t === 'lan-signal' && m.kind === 'retry') && obj(m.data) && JSON.stringify(m.data).length <= 64_000; break;
      case 'lan-genesis': ok = proof(m) && str(m.sessionId) && str(m.by); break;
      case 'lan-admit': case 'lan-evict': ok = proof(m) && str(m.sessionId) && str(m.by) && str(m.member); break;
      case 'lan-state': ok = proof(m) && str(m.memberId) && str(m.sessionId) && Number.isInteger(m.vip) && m.vip >= 0
        && m.vip <= 0xffffffff && Number.isInteger(m.gen) && m.gen >= 0 && m.gen <= 65535; break;
      case 'lan-reach': ok = proof(m) && str(m.memberId) && str(m.sessionId) && bool(m.relay)
        && list(m.reach, MAX_LAN_REACH, x => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x))
        && m.reach.every((x: string, i: number) => !i || x > m.reach[i - 1]); break;
      case 'srv-mirror': ok = proof(m) && str(m.hostId) && str(m.body, 200_000, true); break;
      case 'srv-cmd-v2': ok = proof(m) && validCommandRequest(m as unknown as import('./server-command').ServerCommandRequest); break;
      case 'srv-result-v2': ok = proof(m) && str(m.hostId, 128) && str(m.to, 128) && str(m.instanceId, 128) && validCommandId(m.commandId) && bool(m.ok) && (m.ok ? m.reason === undefined : str(m.reason, 64)); break;
      case 'srv-cmd': ok = proof(m) && str(m.by) && str(m.instanceId) && str(m.command, 512); break;
    }
    return ok ? m as GossipMessage : null;
  } catch { return null; }
}

/** Per-wire AND per-room buckets: reconnecting cannot reset the room's work budget. */
export class RoomIngressBudget {
  private frames = 256;
  private bytes = 4_000_000;
  private proofs = 2400;
  private at: number;
  constructor(now = Date.now()) { this.at = now; }
  take(bytes: number, proofs = 0, now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.at) / 1000;
    this.at = Math.max(this.at, now);
    this.frames = Math.min(256, this.frames + elapsed * 64);
    this.bytes = Math.min(4_000_000, this.bytes + elapsed * 1_000_000);
    this.proofs = Math.min(2400, this.proofs + elapsed * 200);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > ROOM_FRAME_LIMIT || !Number.isInteger(proofs) || proofs < 0
      || this.frames < (bytes ? 1 : 0) || this.bytes < bytes || this.proofs < proofs) return false;
    this.frames -= bytes ? 1 : 0; this.bytes -= bytes; this.proofs -= proofs;
    return true;
  }
}
