import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { WatchHostState, watchPolicyCanonical, watchReadiness, type WatchPolicy } from './room-watch-host';
import { WatchSender, watchCanonical, watchHostCanonical, type WatchMessage } from './room-watch-sync';
import { gossipProofs } from './room-message-auth';
import { validateGossip } from './room-protocol';
const now = 1_000_000, topic = 'room-A';
const keys = crypto.generateKeyPairSync('ed25519');
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sign = (bytes: Uint8Array) => crypto.sign(null, bytes, keys.privateKey).toString('base64');
function policy(hostId = 'host', at = now, by = 'owner'): WatchPolicy {
  const p = { t: 'watch-policy-v1' as const, by, ownerAt: 0, hostId, at, pub, sig: '' };
  p.sig = sign(watchPolicyCanonical(topic, p)); return p;
}
function frame(memberId = 'viewer', action = 'beat', patch: Record<string, unknown> = {}): WatchMessage {
  const sender = new WatchSender();
  if (action === 'leave') sender.next({ fileId: 'movie', action: 'join', position: 0 }, memberId, () => 'a'.repeat(32), now);
  const body = sender.next({ fileId: 'movie', action, position: 5, together: true,
    readiness: 'ready', policyBy: 'owner', policyAt: now, ...patch }, memberId, () => 'a'.repeat(32), now, 3)!;
  return { ...body, pub, sig: sign(watchCanonical(topic, body)), hostSig: sign(watchHostCanonical(topic, body)) };
}
describe('watch host policy and signed readiness', () => {
  it('admits only current-owner revisions and retains the floor when returning to shared mode', () => {
    const state = new WatchHostState();
    expect(state.accept(policy(), 'owner', now)).toBe(true);
    expect(state.accept(policy('attacker', now + 1, 'member'), 'owner', now)).toBe(false);
    expect(state.accept(policy('attacker'), 'owner', now)).toBe(false);
    expect(state.accept(policy('', now + 1), 'owner', now)).toBe(true);
    expect(state.accept(policy(), 'owner', now)).toBe(false);
    expect(state.accept(policy('host', now + 60_001), 'owner', now)).toBe(false);
    expect(state.current('new-owner')).toBeUndefined();
    expect(state.accept(policy('new-host', now - 1, 'new-owner'), 'new-owner', now)).toBe(true);
  });
  it('allows presence/reactions but rejects viewer control, stale hosts and old-client control in host mode', () => {
    const state = new WatchHostState(); state.accept(policy(), 'owner', now);
    for (const action of ['play', 'pause', 'seek', 'rate', 'track', 'state']) {
      expect(state.allows(frame('viewer', action), 'owner')).toBe(false);
      expect(state.allows(frame('host', action), 'owner')).toBe(true);
    }
    expect(state.allows(frame('viewer', 'request', { requested: 'pause' }), 'owner')).toBe(true);
    expect(state.allows(frame('host', 'request', { requested: 'pause' }), 'owner')).toBe(false);
    for (const action of ['join', 'beat', 'leave', 'react']) expect(state.allows(frame('viewer', action), 'owner')).toBe(true);
    expect(state.allows({ ...frame('host', 'play'), v: undefined }, 'owner')).toBe(false);
    state.accept(policy('next', now + 1), 'owner', now);
    expect(state.allows(frame('host', 'play'), 'owner')).toBe(false);
    expect(state.allows(frame('next', 'play', { policyAt: now + 1 }), 'owner')).toBe(true);
    expect(state.allows(frame('viewer', 'request', { requested: 'seek' }), 'owner')).toBe(false);
  });
  it('preserves the original signed v2 bytes and permits old clients in shared mode', () => {
    const m = frame();
    expect(watchCanonical(topic, m)).toEqual(watchCanonical(topic, { ...m, v: undefined, readiness: undefined, hostSig: undefined, policyAt: undefined, policyBy: undefined }));
    expect(new WatchHostState().allows({ ...m, v: undefined }, 'owner')).toBe(true);
  });
  it('does not revive the old host if ownership returns to the same identity', () => {
    const state = new WatchHostState(), old = policy(); state.accept(old, 'owner', now);
    expect(state.current('other', 10)).toBeUndefined();
    expect(state.current('owner', 20)).toBeUndefined();
    expect(state.accept(old, 'owner', now, 20)).toBe(false);
    const next = { ...policy('next', now + 1), ownerAt: 20 };
    next.sig = sign(watchPolicyCanonical(topic, next));
    expect(state.accept(next, 'owner', now, 20)).toBe(true);
    expect(state.current('owner', 20)?.hostId).toBe('next');
    // A coincident policy timestamp after handover still cannot reuse old controls.
    const control = frame('next', 'play', { policyAt: next.at });
    expect(state.allows(control, 'owner', 20)).toBe(false);
    expect(state.allows({ ...control, policyOwnerAt: 20 }, 'owner', 20)).toBe(true);
  });
  it('verifies the policy inside HELLO, and binds readiness/request/policy to the base action', () => {
    const p = policy(), m = frame('viewer', 'request', { requested: 'seek' });
    const verify = (frame: Record<string, unknown>) => gossipProofs(frame as never, topic, 'owner').every(proof =>
      crypto.verify(null, proof.bytes, keys.publicKey, Buffer.from(proof.sig, 'base64')));
    expect(verify({ t: 'hello', watchPolicy: p })).toBe(true);
    expect(verify({ t: 'hello', watchPolicy: { ...p, hostId: 'attacker' } })).toBe(false);
    expect(verify(m)).toBe(true);
    for (const patch of [{ readiness: 'buffering' }, { requested: 'pause' }, { policyAt: now + 1 }, { policyOwnerAt: 1 }, { policyBy: 'other' }, { position: 50 }, { seq: 2 }]) expect(verify({ ...m, ...patch })).toBe(false);
    expect(gossipProofs(m, topic, 'owner')).toHaveLength(2);
  });
  it('rejects malformed/unsigned requests and host extensions at the frame boundary', () => {
    const m = frame('viewer', 'request', { requested: 'track' });
    expect(validateGossip(m)).not.toBeNull();
    for (const patch of [{ hostSig: '' }, { v: 9 }, { v: undefined }, { requested: undefined }, { requested: 'hack' }, { requested: 'state' }, { readiness: 'fake' }, { policyAt: -1 }, { policyBy: 123 }]) expect(validateGossip({ ...m, ...patch })).toBeNull();
    expect(validateGossip(policy())).not.toBeNull();
    expect(validateGossip(policy(''))).not.toBeNull();
    expect(validateGossip({ ...policy(), hostId: 'x'.repeat(1025) })).toBeNull();
  });
  it('separates ready paused/ended media from loading, seeking and decode errors', () => {
    for (const phase of ['paused', 'playing', 'ended']) expect(watchReadiness(phase)).toBe('ready');
    for (const phase of ['seeking', 'resolving', 'metadata', 'buffering']) expect(watchReadiness(phase)).toBe('buffering');
    expect(watchReadiness('decodeError')).toBe('error');
  });
});
