import type { WatchInput, WatchMessage } from './room-watch-sync';

/** Session-only policy. Authority is the current, verified room owner. */
export interface WatchPolicy {
  t: 'watch-policy-v1'; by: string; ownerAt: number; hostId: string; at: number; pub: string; sig: string;
}
export type WatchReadiness = 'ready' | 'buffering' | 'error';
export const WATCH_CONTROLS = ['play', 'pause', 'seek', 'rate', 'track', 'state'] as const;
export type WatchControl = typeof WATCH_CONTROLS[number];
export function validWatchPolicy(value: unknown): value is WatchPolicy {
  if (!value || typeof value !== 'object') return false;
  const p = value as WatchPolicy;
  return p.t === 'watch-policy-v1' && typeof p.by === 'string' && p.by.length > 0 && p.by.length <= 1024
    && typeof p.hostId === 'string' && p.hostId.length <= 1024 && Number.isSafeInteger(p.at) && p.at > 0
    && Number.isSafeInteger(p.ownerAt) && p.ownerAt >= 0
    && typeof p.pub === 'string' && p.pub.length > 0 && p.pub.length <= 2048
    && typeof p.sig === 'string' && p.sig.length > 0 && p.sig.length <= 1024;
}
export function watchPolicyCanonical(topic: string, p: Pick<WatchPolicy, 'by' | 'ownerAt' | 'hostId' | 'at'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['watch-policy-v1', topic, p.by, p.ownerAt, p.hostId, p.at]));
}
/** Call only after signature, identity and ownership-chain verification. */
export class WatchHostState {
  private policy: WatchPolicy | undefined;
  current(ownerId: string, ownerAt = 0): WatchPolicy | undefined { return this.policy?.by === ownerId && this.policy.ownerAt === ownerAt ? this.policy : undefined; }
  accept(p: WatchPolicy, ownerId: string, now = Date.now(), ownerAt = 0): boolean {
    if (!validWatchPolicy(p) || p.by !== ownerId || p.ownerAt !== ownerAt || p.at > now + 60_000) return false;
    const old = this.current(ownerId, ownerAt);
    if (old && p.at <= old.at) return false;
    this.policy = { t: 'watch-policy-v1', by: p.by, ownerAt: p.ownerAt, hostId: p.hostId, at: p.at, pub: p.pub, sig: p.sig };
    return true;
  }
  stamp(ownerId: string, ownerAt = 0): Pick<WatchInput, 'policyBy' | 'policyAt' | 'policyOwnerAt'> {
    const p = this.current(ownerId, ownerAt);
    return { policyBy: p?.by || '', policyAt: p?.at || 0, policyOwnerAt: ownerAt };
  }
  allows(m: WatchMessage, ownerId: string, ownerAt = 0): boolean {
    const p = this.current(ownerId, ownerAt);
    // Old clients remain usable in shared mode. Their controls cannot steer host mode.
    if (m.v !== 3) return !p?.hostId;
    if (m.policyOwnerAt !== ownerAt) return false;
    if (m.policyBy !== (p?.by || '') || m.policyAt !== (p?.at || 0)) return false;
    if (m.action === 'request') return !!p?.hostId && m.memberId !== p.hostId && m.together;
    return !p?.hostId || !WATCH_CONTROLS.includes(m.action as WatchControl) || m.memberId === p.hostId;
  }
}
export function watchReadiness(phase: string): WatchReadiness {
  if (['networkError', 'decodeError', 'downloadError'].includes(phase)) return 'error';
  return ['playing', 'paused', 'ended'].includes(phase) ? 'ready' : 'buffering';
}
