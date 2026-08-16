import { describe, it, expect } from 'vitest';
import {
  normalizeLanPrefs, withPicks, addPick, removePick, addApp, removeApp,
  sameLanPrefs, preselectPicks, samePath,
  reusableSessionId, sessionFloor, withSession, noteSessionFloor, rotateSession,
  EMPTY_LAN_PREFS, LAN_MAX_PICKS, LAN_MAX_APPS,
} from './lan-prefs';
import { MAX_LAN_PEERS } from './lan-types';

const SELF = 'self0000000000000000000000000000';
const A = 'aaaa000000000000000000000000aaaa';
const B = 'bbbb000000000000000000000000bbbb';
const C = 'cccc000000000000000000000000cccc';

const SID = `${SELF}.0123456789abcdef`;        // ours: prefix === SELF
const THEIRS = `${A}.fedcba9876543210`;        // a session we merely joined

const prefs = (picks: string[] = [], apps: string[] = []) => ({ picks, apps });
const withSess = (id: string, floor: number, picks: string[] = [], apps: string[] = []) =>
  ({ picks, apps, session: { id, floor } });

describe('caps', () => {
  it('leaves one mesh slot for self', () => {
    expect(LAN_MAX_PICKS).toBe(MAX_LAN_PEERS - 1);
  });
});

describe('normalizeLanPrefs', () => {
  it('treats every unusable shape as "nothing remembered"', () => {
    for (const bad of [null, undefined, 0, '', 'picks', [], { picks: 'A' }, { apps: 42 }]) {
      expect(normalizeLanPrefs(bad)).toEqual({ picks: [], apps: [] });
    }
  });

  it('keeps the good entries out of a partly-corrupt list', () => {
    const out = normalizeLanPrefs({ picks: [A, 42, null, B, ''], apps: ['C:\\g.exe', {}, 7] });
    expect(out.picks).toEqual([A, B]);
    expect(out.apps).toEqual(['C:\\g.exe']);
  });

  it('drops over-long entries rather than truncating them', () => {
    // A truncated path is a DIFFERENT path and a truncated memberId matches nobody.
    const out = normalizeLanPrefs({ picks: ['x'.repeat(129)], apps: ['C:\\' + 'y'.repeat(1100)] });
    expect(out).toEqual({ picks: [], apps: [] });
  });

  it('de-duplicates and caps both lists', () => {
    const many = Array.from({ length: 40 }, (_, i) => 'm'.repeat(8) + i);
    const dupApps = ['C:\\Games\\a.exe', 'c:/games/A.EXE']; // same game, two spellings
    const out = normalizeLanPrefs({ picks: [...many, ...many], apps: dupApps });
    expect(out.picks).toHaveLength(LAN_MAX_PICKS);
    expect(new Set(out.picks).size).toBe(LAN_MAX_PICKS);
    expect(out.apps).toEqual(['C:\\Games\\a.exe']);
  });

  it('returns the shared frozen empty value, which cannot be mutated into a leak', () => {
    const out = normalizeLanPrefs({});
    expect(out).toBe(EMPTY_LAN_PREFS);
    expect(() => { (out.picks as string[]).push(A); }).toThrow();
  });
});

describe('withPicks', () => {
  it('records the admitted list in pick order', () => {
    expect(withPicks(EMPTY_LAN_PREFS, [B, A], SELF).picks).toEqual([B, A]);
  });

  it('never records self — the host self-admits inside the session', () => {
    expect(withPicks(EMPTY_LAN_PREFS, [A, SELF, B], SELF).picks).toEqual([A, B]);
  });

  it('replaces rather than merges, so an unpicked member is forgotten', () => {
    expect(withPicks(prefs([A, B]), [C], SELF).picks).toEqual([C]);
  });

  it('de-duplicates, caps, and keeps the apps untouched', () => {
    const many = Array.from({ length: 30 }, (_, i) => 'p'.repeat(8) + i);
    const out = withPicks(prefs([], ['C:\\g.exe']), [...many, ...many], SELF);
    expect(out.picks).toHaveLength(LAN_MAX_PICKS);
    expect(out.apps).toEqual(['C:\\g.exe']);
  });

  it('does not mutate its input', () => {
    const before = prefs([A]);
    withPicks(before, [B, C], SELF);
    expect(before.picks).toEqual([A]);
  });
});

describe('addPick / removePick', () => {
  it('appends a late invite', () => {
    expect(addPick(prefs([A]), B, SELF).picks).toEqual([A, B]);
  });

  it('is a no-op for self, a duplicate, junk, or a full list', () => {
    const p = prefs([A]);
    expect(addPick(p, SELF, SELF)).toBe(p);
    expect(addPick(p, A, SELF)).toBe(p);
    expect(addPick(p, '', SELF)).toBe(p);
    const full = prefs(Array.from({ length: LAN_MAX_PICKS }, (_, i) => 'f'.repeat(8) + i));
    expect(addPick(full, A, SELF)).toBe(full);
  });

  it('forgets an evicted member, so the next Start does not re-offer them', () => {
    expect(removePick(prefs([A, B]), A).picks).toEqual([B]);
    const p = prefs([B]);
    expect(removePick(p, A)).toBe(p); // unknown member — no write
  });
});

describe('samePath', () => {
  it('treats Windows case and separator variants as one game', () => {
    expect(samePath('C:\\Games\\a.exe', 'c:/games/A.EXE')).toBe(true);
    expect(samePath('C:\\Games\\a.exe', 'C:\\Games\\b.exe')).toBe(false);
  });
});

describe('addApp / removeApp', () => {
  it('puts the newest game first', () => {
    expect(addApp(prefs([], ['C:\\a.exe']), 'C:\\b.exe').apps).toEqual(['C:\\b.exe', 'C:\\a.exe']);
  });

  it('re-adding an existing game moves it to the front instead of duplicating', () => {
    const out = addApp(prefs([], ['C:\\a.exe', 'C:\\b.exe']), 'c:/B.EXE');
    expect(out.apps).toEqual(['c:/B.EXE', 'C:\\a.exe']);
  });

  it('is a no-op when the game is already the most recent (no disk write)', () => {
    const p = prefs([], ['C:\\a.exe', 'C:\\b.exe']);
    expect(addApp(p, 'c:/A.EXE')).toBe(p);
    expect(addApp(p, '')).toBe(p);
  });

  it('evicts the least recent past the cap and keeps the picks', () => {
    let p = prefs([A], []);
    for (let i = 0; i <= LAN_MAX_APPS; i++) p = addApp(p, `C:\\g${i}.exe`);
    expect(p.apps).toHaveLength(LAN_MAX_APPS);
    expect(p.apps[0]).toBe(`C:\\g${LAN_MAX_APPS}.exe`);
    expect(p.apps).not.toContain('C:\\g0.exe');
    expect(p.picks).toEqual([A]);
  });

  it('removeApp drops a moved/uninstalled game by any spelling', () => {
    expect(removeApp(prefs([], ['C:\\a.exe', 'C:\\b.exe']), 'c:/A.EXE').apps).toEqual(['C:\\b.exe']);
    const p = prefs([], ['C:\\b.exe']);
    expect(removeApp(p, 'C:\\a.exe')).toBe(p); // nothing to forget — no write
  });
});

describe('the reused session (stable vIPs)', () => {
  it('normalises a session only when the id and its floor are BOTH sound', () => {
    expect(normalizeLanPrefs({ session: { id: SID, floor: 42 } }).session).toEqual({ id: SID, floor: 42 });
    // A half-written pair is dropped whole: an id without a floor would re-open
    // cross-session replay, a floor without an id protects nothing.
    for (const bad of [
      { id: SID }, { floor: 42 }, { id: SID, floor: -1 }, { id: SID, floor: 1.5 },
      { id: SID, floor: 'x' }, { id: '', floor: 1 }, { id: SID, floor: Number.MAX_VALUE },
      'session', 42, null,
    ]) {
      expect(normalizeLanPrefs({ session: bad }).session).toBeUndefined();
    }
  });

  it('reuses only a session THIS install created', () => {
    expect(reusableSessionId(withSess(SID, 5), SELF)).toBe(SID);
    // The id commits to its creator (pinGenesis binds `by` to the prefix), so a
    // session we merely joined can never be re-hosted by us.
    expect(reusableSessionId(withSess(THEIRS, 5), SELF)).toBeNull();
    expect(reusableSessionId(withSess(SID, 5), B)).toBeNull();   // identity changed
    expect(reusableSessionId(EMPTY_LAN_PREFS, SELF)).toBeNull(); // nothing remembered
    expect(reusableSessionId(withSess(SID, 5), '')).toBeNull();
  });

  it('hands out a floor only for the exact session it belongs to', () => {
    const p = withSess(SID, 900);
    expect(sessionFloor(p, SID)).toBe(900);
    expect(sessionFloor(p, THEIRS)).toBe(0); // a session we have never run has no grants of ours
    expect(sessionFloor(EMPTY_LAN_PREFS, SID)).toBe(0);
  });

  it('keeps the floor when re-entering the same session, resets it for a new one', () => {
    const p = withSess(SID, 900, [A]);
    expect(withSession(p, SID)).toBe(p);                    // re-entry: untouched, floor kept
    expect(withSession(p, THEIRS).session).toEqual({ id: THEIRS, floor: 0 });
    expect(withSession(p, THEIRS).picks).toEqual([A]);      // unrelated fields survive
    expect(withSession(p, '')).toBe(p);                     // junk id changes nothing
  });

  it('raises the watermark monotonically for its own session', () => {
    const p = withSess(SID, 900);
    expect(noteSessionFloor(p, SID, 1200).session).toEqual({ id: SID, floor: 1200 });
    expect(noteSessionFloor(p, SID, 900)).toBe(p);  // equal — no write
    expect(noteSessionFloor(p, SID, 100)).toBe(p);  // never backwards
    expect(noteSessionFloor(p, SID, 1.5)).toBe(p);
    expect(noteSessionFloor(p, '', 5000)).toBe(p);
  });

  it('adopts a session when none is remembered — the passive-watcher case', () => {
    // Someone who watches a host's session without ever joining would otherwise
    // keep a floor of 0, and its PASSIVE core (built from gossip before Accept)
    // would take a grant replayed from an earlier run of that session.
    expect(noteSessionFloor(EMPTY_LAN_PREFS, THEIRS, 700).session).toEqual({ id: THEIRS, floor: 700 });
    expect(noteSessionFloor(prefs([A]), THEIRS, 700).picks).toEqual([A]);
  });

  it("never lets another session displace the one we are tracking", () => {
    // Anyone can create a session; overwriting here would be a way for any room
    // member to wipe the watermark protecting the session we actually play in.
    const p = withSess(SID, 900);
    expect(noteSessionFloor(p, THEIRS, 5000)).toBe(p);
    expect(noteSessionFloor(p, THEIRS, 1)).toBe(p);
    // Switching sessions stays a deliberate act (Start / Accept).
    expect(withSession(p, THEIRS).session).toEqual({ id: THEIRS, floor: 0 });
  });

  it('rotation drops the session but keeps the rest of the setup', () => {
    const p = withSess(SID, 900, [A], ['C:\\g.exe']);
    const r = rotateSession(p);
    expect(r.session).toBeUndefined();
    expect(r.picks).toEqual([A]);
    expect(r.apps).toEqual(['C:\\g.exe']);
    expect(rotateSession(r)).toBe(r); // already rotated — no write
  });

  it('every pick/app helper carries the session through', () => {
    // The regression this guards: a helper written before `session` existed
    // returning {picks, apps} and silently dropping it — which would read to the
    // user as "the addresses changed because I invited someone".
    const p = withSess(SID, 900, [A], ['C:\\a.exe']);
    for (const out of [
      withPicks(p, [B], SELF), addPick(p, B, SELF), removePick(p, A),
      addApp(p, 'C:\\b.exe'), removeApp(p, 'C:\\a.exe'),
    ]) {
      expect(out.session).toEqual({ id: SID, floor: 900 });
    }
  });
});

describe('sameLanPrefs', () => {
  it('distinguishes content and order', () => {
    expect(sameLanPrefs(prefs([A, B], ['x']), prefs([A, B], ['x']))).toBe(true);
    expect(sameLanPrefs(prefs([A, B]), prefs([B, A]))).toBe(false);
    expect(sameLanPrefs(prefs([A]), prefs([A, B]))).toBe(false);
    expect(sameLanPrefs(prefs([], ['x']), prefs([], ['y']))).toBe(false);
  });

  it('notices a session id or floor change, so the watermark actually reaches disk', () => {
    expect(sameLanPrefs(withSess(SID, 1), withSess(SID, 1))).toBe(true);
    expect(sameLanPrefs(withSess(SID, 1), withSess(SID, 2))).toBe(false);
    expect(sameLanPrefs(withSess(SID, 1), withSess(THEIRS, 1))).toBe(false);
    expect(sameLanPrefs(withSess(SID, 1), prefs())).toBe(false);
  });
});

describe('preselectPicks', () => {
  it('keeps remembered order and drops anyone not selectable now', () => {
    // B left the room, C is already admitted and thus not a candidate.
    expect(preselectPicks([B, A, C], [A])).toEqual([A]);
  });

  it('never pre-ticks past the cap — an invisible selection would still be signed', () => {
    const ids = Array.from({ length: 12 }, (_, i) => 'm'.repeat(8) + i);
    expect(preselectPicks(ids, ids)).toHaveLength(LAN_MAX_PICKS);
    expect(preselectPicks(ids, ids, 2)).toEqual(ids.slice(0, 2));
    expect(preselectPicks(ids, ids, 0)).toEqual([]);
  });

  it('is empty when nothing is remembered or nothing is available', () => {
    expect(preselectPicks([], [A, B])).toEqual([]);
    expect(preselectPicks([A, B], [])).toEqual([]);
  });
});
