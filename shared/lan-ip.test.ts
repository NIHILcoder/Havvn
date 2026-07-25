import { describe, it, expect } from 'vitest';
import {
  sessionSubnet, deriveVip, verifyVipClaim, isInSubnet, resolveVipOwners, vipToString, fnv1a,
} from './lan-ip';
import { numToIp } from './ip-range';

const A = '0123456789abcdef0123456789abcdef'; // memberId-shaped (32 hex)
const B = 'fedcba9876543210fedcba9876543210';
const SID = 'session-alpha';

describe('sessionSubnet', () => {
  it('always lands inside 100.64.0.0/10', () => {
    for (let i = 0; i < 500; i++) {
      const { base } = sessionSubnet('s' + i);
      const oct1 = (base >>> 24) & 0xff;
      const oct2 = (base >>> 16) & 0xff;
      expect(oct1).toBe(100);
      expect(oct2).toBeGreaterThanOrEqual(64);
      expect(oct2).toBeLessThanOrEqual(127);
      expect(base & 0xffff).toBe(0); // /16 network address
    }
  });

  it('is deterministic and yields a correct directed broadcast', () => {
    const s = sessionSubnet(SID);
    expect(sessionSubnet(SID)).toEqual(s);
    expect((s.broadcast & 0xffff) >>> 0).toBe(0xffff);
    expect((s.broadcast >>> 16)).toBe(s.base >>> 16);
    expect(s.netmask >>> 0).toBe(0xffff0000);
  });
});

describe('deriveVip', () => {
  it('is deterministic per (session, member, gen)', () => {
    expect(deriveVip(SID, A)).toBe(deriveVip(SID, A, 0));
    expect(deriveVip(SID, A)).not.toBe(deriveVip(SID, A, 1)); // gen bump moves it
    expect(deriveVip(SID, A)).not.toBe(deriveVip('other', A)); // session-scoped
  });

  it('stays inside the session /16 and avoids network/broadcast hosts', () => {
    const sub = sessionSubnet(SID);
    for (const m of [A, B, 'c'.repeat(32), '1'.repeat(32)]) {
      for (let gen = 0; gen < 8; gen++) {
        const vip = deriveVip(SID, m, gen);
        expect(isInSubnet(vip, sub)).toBe(true);
        const host = vip & 0xffff;
        expect(host).not.toBe(0x0000);
        expect(host).not.toBe(0xffff);
      }
    }
  });

  it('spreads across many members without pathological collisions', () => {
    const seen = new Set<number>();
    let collisions = 0;
    for (let i = 0; i < 2000; i++) {
      const vip = deriveVip(SID, 'member-' + i);
      if (seen.has(vip)) collisions++;
      seen.add(vip);
    }
    // 2000 members in 16 host bits ≈ birthday ~ many collisions expected, but
    // the distribution must not be degenerate (would be near 2000 if broken).
    expect(collisions).toBeLessThan(60);
  });
});

describe('verifyVipClaim', () => {
  it('accepts the true derivation and rejects forgeries', () => {
    const real = deriveVip(SID, A, 0);
    expect(verifyVipClaim(SID, A, 0, real)).toBe(true);
    // B claims A's address → must be rejected (interception defence)
    expect(verifyVipClaim(SID, B, 0, real)).toBe(false);
    // wrong gen
    expect(verifyVipClaim(SID, A, 1, real)).toBe(false);
    // arbitrary claim
    expect(verifyVipClaim(SID, A, 0, (real ^ 1) >>> 0)).toBe(false);
  });
});

describe('resolveVipOwners', () => {
  it('drops forged claims and converges on lowest memberId for a real collision', () => {
    const shared = 0x64500001;
    const claims = [
      { memberId: A, gen: 0, vip: deriveVip(SID, A, 0) },
      { memberId: B, gen: 0, vip: deriveVip(SID, B, 0) },
      { memberId: 'zz', gen: 0, vip: shared }, // forged — not its derivation
    ];
    const owners = resolveVipOwners(SID, claims);
    expect(owners.get(deriveVip(SID, A, 0))).toBe(A);
    expect([...owners.values()]).not.toContain('zz'); // forged claim ignored
  });

  it('is order-independent (same result whatever the flood order)', () => {
    // Find two members that genuinely derive the SAME vip (a real collision).
    let m1 = '', m2 = '';
    const map = new Map<number, string>();
    for (let i = 0; i < 100000 && !m1; i++) {
      const id = 'm' + i;
      const vip = deriveVip(SID, id, 0);
      const prev = map.get(vip);
      if (prev) { m1 = prev < id ? prev : id; m2 = prev < id ? id : prev; }
      else map.set(vip, id);
    }
    expect(m1).not.toBe(''); // a collision must exist in the search space
    const vip = deriveVip(SID, m1, 0);
    const c1 = { memberId: m1, gen: 0, vip };
    const c2 = { memberId: m2, gen: 0, vip };
    const fwd = resolveVipOwners(SID, [c1, c2]).get(vip);
    const rev = resolveVipOwners(SID, [c2, c1]).get(vip);
    expect(fwd).toBe(rev);
    expect(fwd).toBe(m1 < m2 ? m1 : m2); // lowest memberId wins
  });
});

describe('vipToString', () => {
  it('formats via the shared dotted-quad helper', () => {
    const vip = deriveVip(SID, A);
    expect(vipToString(vip)).toBe(numToIp(vip >>> 0));
    expect(vipToString(0x64400001)).toBe('100.64.0.1');
  });
});

describe('fnv1a', () => {
  it('is a stable 32-bit hash', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
});
