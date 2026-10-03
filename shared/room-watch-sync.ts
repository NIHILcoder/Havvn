import { WATCH_CONTROLS, type WatchControl, type WatchReadiness } from './room-watch-host';
/** Transient watch commands have their own signature domain and replay floors. */
export const WATCH_SYNC_VERSION = 2;
export const WATCH_MEMBER_LIMIT = 256;
export const WATCH_ACTIONS = ['play', 'pause', 'seek', 'state', 'join', 'leave', 'beat', 'react', 'rate', 'track', 'request'] as const;
export type WatchAction = typeof WATCH_ACTIONS[number];
export interface WatchInput {
  fileId: string; action: string; position: number; rate?: number;
  playing?: boolean; together?: boolean; emoji?: string;
  readiness?: WatchReadiness; requested?: WatchControl; policyBy?: string; policyAt?: number; policyOwnerAt?: number;
}
export interface WatchMessage {
  t: 'sync-v2'; v?: 3; hostSig?: string; fileId: string; action: WatchAction; position: number; rate: number;
  playing: boolean; together: boolean; emoji: string; memberId: string;
  readiness?: WatchReadiness; requested?: WatchControl; policyBy?: string; policyAt?: number; policyOwnerAt?: number;
  sessionId: string; startedAt: number; seq: number; at: number; pub: string; sig: string;
}
/** Verified transient state delivered to either player. Keep ordering metadata. */
export interface WatchPlaybackEvent extends Omit<WatchMessage, 't' | 'pub' | 'sig'> {
  name: string;
  v?: 3;
  avatarSeed?: string;
}
export function validWatchInput(value: unknown): value is WatchInput {
  if (!value || typeof value !== 'object') return false;
  const m = value as WatchInput;
  return typeof m.fileId === 'string' && m.fileId.length > 0 && m.fileId.length <= 1024
    && WATCH_ACTIONS.includes(m.action as WatchAction)
    && Number.isFinite(m.position) && m.position >= 0 && m.position <= 31_536_000
    && (m.rate === undefined || (Number.isFinite(m.rate) && m.rate >= 0.25 && m.rate <= 4))
    && (m.playing === undefined || typeof m.playing === 'boolean')
    && (m.together === undefined || typeof m.together === 'boolean')
    && (m.readiness === undefined || ['ready', 'buffering', 'error'].includes(m.readiness))
    && (m.policyBy === undefined || typeof m.policyBy === 'string' && m.policyBy.length <= 1024)
    && (m.policyAt === undefined || Number.isSafeInteger(m.policyAt) && m.policyAt >= 0)
    && (m.policyOwnerAt === undefined || Number.isSafeInteger(m.policyOwnerAt) && m.policyOwnerAt >= 0)
    && (m.action !== 'request' || m.requested !== 'state' && WATCH_CONTROLS.includes(m.requested as WatchControl))
    && (m.requested === undefined || WATCH_CONTROLS.includes(m.requested))
    && (m.emoji === undefined || (typeof m.emoji === 'string' && m.emoji.length <= 16));
}
export function validWatchMessage(value: unknown): value is WatchMessage {
  if (!validWatchInput(value)) return false;
  const m = value as WatchMessage;
  return m.t === 'sync-v2' && (m.v === undefined && m.action !== 'request' || m.v === 3
      && ['ready', 'buffering', 'error'].includes(m.readiness!)
      && typeof m.policyBy === 'string' && Number.isSafeInteger(m.policyAt) && Number.isSafeInteger(m.policyOwnerAt)
      && typeof m.hostSig === 'string' && m.hostSig.length > 0 && m.hostSig.length <= 1024) && typeof m.sessionId === 'string' && /^[0-9a-f]{32}$/.test(m.sessionId)
    && Number.isSafeInteger(m.seq) && m.seq > 0
    && Number.isSafeInteger(m.startedAt) && m.startedAt > 0
    && Number.isSafeInteger(m.at) && m.at >= m.startedAt
    && typeof m.rate === 'number' && typeof m.playing === 'boolean' && typeof m.together === 'boolean'
    && typeof m.emoji === 'string';
}
export function watchCanonical(topic: string, m: Omit<WatchMessage, 'pub' | 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['sync-v2', topic, m.memberId, m.sessionId, m.startedAt,
    m.seq, m.fileId, m.action, m.position, m.rate, m.at, m.playing, m.together, m.emoji]));
}

/** Additional domain signs every extension AND its base command; v2 bytes stay stable. */
export function watchHostCanonical(topic: string, m: Omit<WatchMessage, 'pub' | 'sig'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['watch-host-v1', Array.from(watchCanonical(topic, m)),
    m.readiness, m.requested || '', m.policyBy, m.policyAt, m.policyOwnerAt]));
}

/** A new session always advances the signed epoch, including clock steps back. */
export class WatchSender {
  private sessionId = '';
  private startedAt = 0;
  private seq = 0;
  private closed = true;
  next(input: WatchInput, memberId: string, randomId: () => string, now = Date.now(), version: 2 | 3 = 2): Omit<WatchMessage, 'pub' | 'sig'> | null {
    if (!validWatchInput(input) || version === 2 && input.action === 'request') return null;
    if (input.action === 'leave' && this.closed) return null;
    if (this.closed || input.action === 'join') {
      this.sessionId = randomId();
      this.startedAt = Math.max(now, this.startedAt + 1);
      this.seq = 0;
      this.closed = false;
    }
    const m = { t: 'sync-v2' as const, fileId: input.fileId, position: input.position, action: input.action as WatchAction,
      memberId, sessionId: this.sessionId, startedAt: this.startedAt, seq: ++this.seq,
      at: Math.max(now, this.startedAt), rate: input.rate ?? 1, playing: input.playing === true,
      together: input.together === true, emoji: input.emoji ?? '',
      ...(version === 3 ? { v: 3 as const, readiness: input.readiness || 'buffering', requested: input.requested, policyBy: input.policyBy || '', policyAt: input.policyAt || 0, policyOwnerAt: input.policyOwnerAt || 0 } : {}) };
    if (input.action === 'leave') this.closed = true;
    return m;
  }
}

/** Floors are never evicted: eviction would reopen a closed session's replay window. */
export class WatchReceiver {
  private floors = new Map<string, { sessionId: string; startedAt: number; seq: number; closed: boolean; tokens: number; refilled: number }>();
  isCurrent(m: WatchMessage): boolean {
    const p = this.floors.get(m.memberId);
    return !!p && p.sessionId === m.sessionId && p.startedAt === m.startedAt && p.seq === m.seq;
  }
  accept(m: WatchMessage, now = Date.now()): boolean {
    if (!validWatchMessage(m) || m.at < now - 30_000 || m.at > now + 60_000) return false;
    const p = this.floors.get(m.memberId);
    if (p && (m.startedAt < p.startedAt || (m.startedAt === p.startedAt
      && (m.sessionId !== p.sessionId || m.seq <= p.seq || p.closed)))) return false;
    if (!p && this.floors.size >= WATCH_MEMBER_LIMIT) return false;
    const tokens = p ? Math.min(20, p.tokens + Math.max(0, now - p.refilled) * 0.01) : 20;
    if (tokens < 1) return false;
    this.floors.set(m.memberId, { sessionId: m.sessionId, startedAt: m.startedAt, seq: m.seq,
      closed: m.action === 'leave', tokens: tokens - 1, refilled: now });
    return true;
  }
}
