/**
 * Per-room virtual-LAN preferences — the small LOCAL memory that stops every game
 * night from beginning with the same setup chores: re-picking the same friends out
 * of the roster, and re-pointing the firewall troubleshooter at the same game .exe.
 *
 * ─ THE SESSION ID, AND WHY IT CARRIES A WATERMARK ───────────────────────────
 * Reusing the `sessionId` across restarts is what makes the addresses stable: the
 * subnet and every member's vIP derive from it (sessionSubnet / deriveVip), so a
 * fresh id every night means a fresh set of addresses every night.
 *
 * But the id is also a security boundary. LanSessionCore.applyAdmit documents it:
 * the sessionId gate is what stops a host-signed `lan-admit` from a PAST session
 * replaying into a fresh one, and it works only because anti-replay floors start
 * EMPTY in a new core. Reuse the id with empty floors and any room member can
 * re-broadcast last week's admit to re-admit somebody the host did not pick
 * tonight.
 *
 * `session.floor` is what closes that hole: the highest admit/evict `at` any run
 * of this session has applied, seeded back into the core so every already-issued
 * grant sits below its floor. Two properties make one scalar enough:
 *   • admit/evict are applied ONLY when `by === hostId`, so every value in those
 *     floors comes from ONE clock — the host's. No clock-domain mixing.
 *   • the host seeds its own emission clock from the same number, so its next
 *     grant clears the watermark even if its wall clock moved backwards.
 * Presence (`lan-state` / `lan-reach`) is NOT covered, on purpose: those carry
 * each announcer's own clock and grant nothing. See LanSessionCore.floorSeed.
 *
 * EVICTION ROTATES THE ID instead of relying on the watermark. `evicted` is a
 * sticky in-memory set, so a reused id would quietly downgrade "terminal for this
 * session" to "terminal until the app restarts". Dropping the id on evict makes
 * every grant ever issued under it inert by the sessionId gate — a stronger
 * guarantee than the floor, at the price of new addresses after a removal.
 *
 * ─ WHAT THESE PREFERENCES ARE NOT ───────────────────────────────────────────
 * They are a local convenience, never an authority. A remembered pick does NOT
 * admit anybody: it only pre-fills the host's picker and the admit list the host
 * then SIGNS, which travels the same host-gated path as a hand-picked one. A
 * remembered app path does not grant anything either — the elevated helper
 * re-validates every path it is handed (validateGameExePath) exactly as it does
 * for a freshly picked one. So a tampered store can waste a rule or a slot; it
 * can never widen the trust boundary.
 *
 * Pure + node-testable (the shared/ rule: zero electron imports), because these
 * are the decisions worth pinning with tests — the store and the IPC around them
 * are plumbing.
 */
import { MAX_LAN_PEERS } from './lan-types';
import { sessionHostPrefix } from './lan-session-core';

/** One room's remembered LAN setup. Both roles share the shape: a host fills
 *  `picks`, a joiner never does, and either may collect `apps`. */
export interface LanRoomPrefs {
  /**
   * memberIds the host admitted last time, in the order they were picked. Used to
   * pre-tick the peer picker — NEVER to admit anyone on its own.
   */
  picks: string[];
  /**
   * Absolute paths of executables that were granted a scoped inbound allow-rule
   * through the elevated helper, most-recent first. Re-applied when a session
   * comes up, because teardown deletes every rule the session created (the
   * "teardown leaves nothing behind" guarantee is worth keeping — so the rules
   * are re-made rather than left lying around).
   */
  apps: string[];
  /**
   * The session this room re-enters, so its addresses survive a restart. Absent ⇒
   * the next Start mints a fresh one (a room that has never run LAN, or one whose
   * id was rotated by an eviction).
   *
   * The two fields are ONE value and must never be separated: an id without its
   * floor would re-open the cross-session replay this module exists to close, and
   * a floor without its id belongs to nothing.
   */
  session?: {
    /** `${hostMemberId}.${16hex}` — only its creator may reuse it. */
    id: string;
    /** Highest admit/evict `at` any run of this session has applied (host clock). */
    floor: number;
  };
}

/** Self occupies one mesh slot, so a host can admit at most this many others —
 *  the same arithmetic LanPeerPicker does for its own cap. */
export const LAN_MAX_PICKS = MAX_LAN_PEERS - 1;

/**
 * Cap on remembered game executables. Bounds the store entry and the number of
 * re-apply round-trips a session start pays for; a room that has legitimately
 * needed more than 16 different games' rules is better served by re-adding the
 * odd one than by an unbounded list nobody prunes.
 *
 * Kept EQUAL to the helper's own per-session MAX_LAN_APP_RULES (helper-main.ts),
 * so a full remembered list can always be re-applied in one session. Raising this
 * one alone would produce a list whose tail is silently refused every start.
 */
export const LAN_MAX_APPS = 16;

/** The "nothing remembered yet" value. Frozen DEEP: it is handed out by
 *  normalizeLanPrefs on every unusable input, so one caller pushing into its
 *  arrays would contaminate every later read in the process. Freezing the object
 *  alone is not enough — the arrays are what a caller would reach for. */
export const EMPTY_LAN_PREFS: LanRoomPrefs = Object.freeze({
  picks: Object.freeze([] as string[]),
  apps: Object.freeze([] as string[]),
}) as LanRoomPrefs;

/** Longest path we will keep. Windows' extended limit is 32767, but a value that
 *  long in this list is a corrupt store, not a game. */
const MAX_APP_PATH = 1024;

/** Longest memberId we will keep (they are hex key-derivations; this is slack). */
const MAX_MEMBER_ID = 128;

/** `${memberId}.${16hex}` plus slack. */
const MAX_SESSION_ID = 192;

const isStr = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Build the next value, carrying forward every field the caller did not touch.
 * Every helper below goes through this, so a field added later (as `session` was)
 * cannot be silently dropped by a helper written before it existed — which would
 * have meant "picking a player forgets the session id", i.e. new addresses at the
 * next Start for no visible reason.
 *
 * `'session' in patch` rather than `patch.session !== undefined`, so a helper can
 * deliberately CLEAR the session (rotation) as well as replace it.
 */
const next = (prefs: LanRoomPrefs, patch: Partial<LanRoomPrefs>): LanRoomPrefs => {
  const out: LanRoomPrefs = {
    picks: patch.picks ?? prefs.picks,
    apps: patch.apps ?? prefs.apps,
  };
  const session = 'session' in patch ? patch.session : prefs.session;
  if (session) out.session = session;
  return out;
};

/**
 * Windows paths are case-insensitive and separator-tolerant, so `C:\Games\a.exe`
 * and `c:/games/A.EXE` are ONE game. Comparing them raw would let the same rule
 * accumulate a new slot on every re-pick until the cap silently evicted a real
 * entry.
 */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
}

/**
 * Coerce whatever the store handed back into a usable value. The store is a JSON
 * file the user can edit and a previous version may have written a different
 * shape, so every field is treated as hostile: wrong types collapse to empty,
 * over-long entries are dropped rather than truncated (a truncated path is a
 * DIFFERENT path, and a truncated memberId matches nobody), and both lists are
 * de-duplicated and capped.
 */
export function normalizeLanPrefs(raw: unknown): LanRoomPrefs {
  if (!raw || typeof raw !== 'object') return EMPTY_LAN_PREFS;
  const r = raw as { picks?: unknown; apps?: unknown; session?: unknown };
  const picks: string[] = [];
  if (Array.isArray(r.picks)) {
    for (const v of r.picks) {
      if (!isStr(v, MAX_MEMBER_ID)) continue;
      if (picks.includes(v)) continue;
      picks.push(v);
      if (picks.length >= LAN_MAX_PICKS) break;
    }
  }
  const apps: string[] = [];
  if (Array.isArray(r.apps)) {
    for (const v of r.apps) {
      if (!isStr(v, MAX_APP_PATH)) continue;
      if (apps.some((p) => samePath(p, v))) continue;
      apps.push(v);
      if (apps.length >= LAN_MAX_APPS) break;
    }
  }
  // The id and its floor are ONE value: a half-written pair is dropped whole,
  // because an id whose floor was lost would re-open cross-session replay and a
  // floor whose id was lost protects nothing.
  let session: LanRoomPrefs['session'];
  const s = r.session as { id?: unknown; floor?: unknown } | undefined;
  if (s && typeof s === 'object' && isStr(s.id, MAX_SESSION_ID)
    && typeof s.floor === 'number' && Number.isSafeInteger(s.floor) && s.floor >= 0) {
    session = { id: s.id, floor: s.floor };
  }
  if (picks.length === 0 && apps.length === 0 && !session) return EMPTY_LAN_PREFS;
  return session ? { picks, apps, session } : { picks, apps };
}

// ── The reused session (stable vIPs) ────────────────────────────────────────

/**
 * The session id this install may RE-ENTER as host, or null to mint a fresh one.
 *
 * Gated on the id's own committed creator: a sessionId is `${hostId}.${random}`
 * and pinGenesis binds `by` to that prefix, so an id minted by somebody else (a
 * session we JOINED, or one left behind by an identity we no longer hold) can
 * never be pinned by us and must not be reused — we would announce a genesis every
 * peer rejects, and the session would never come up.
 */
export function reusableSessionId(prefs: LanRoomPrefs, selfMemberId: string): string | null {
  const s = prefs.session;
  if (!s || !selfMemberId) return null;
  return sessionHostPrefix(s.id) === selfMemberId ? s.id : null;
}

/**
 * The watermark to seed a core for `sessionId` with — 0 unless it is the very
 * session this room remembers. The exact-match rule is what makes a rotated (or
 * somebody else's) session start from a clean floor, which is correct: an id we
 * have never run has no grants of ours to replay.
 */
export function sessionFloor(prefs: LanRoomPrefs, sessionId: string): number {
  const s = prefs.session;
  return s && s.id === sessionId ? s.floor : 0;
}

/** Record the session this room is now running. Re-entering the SAME id keeps its
 *  floor (that is the whole point); a different id starts at 0. */
export function withSession(prefs: LanRoomPrefs, sessionId: string): LanRoomPrefs {
  if (!isStr(sessionId, MAX_SESSION_ID)) return prefs;
  if (prefs.session?.id === sessionId) return prefs; // re-entering: keep its floor
  return next(prefs, { session: { id: sessionId, floor: 0 } });
}

/**
 * Record a grant the engine just applied. Three cases, and the third is the point:
 *
 *   • same session  → raise the watermark (never backwards).
 *   • NO session yet → ADOPT this one, at this grant. Without adoption, a member
 *     who watches a host's session for weeks without ever joining it keeps a floor
 *     of 0: its PASSIVE core (the one the engine builds straight from gossip,
 *     before any Accept) would take a grant replayed from an earlier run, and the
 *     replayed member would look admitted the moment that install did accept.
 *     Adoption costs nothing — the engine reports only grants it already verified
 *     as host-signed for that pinned session.
 *   • another session → UNCHANGED. Anyone can create a session, so overwriting
 *     here would hand any room member a way to wipe the watermark protecting the
 *     session we actually play in — a downgrade, dressed as bookkeeping. Switching
 *     to a different session stays a DELIBERATE act (withSession, from Start or
 *     Accept).
 */
export function noteSessionFloor(prefs: LanRoomPrefs, sessionId: string, at: number): LanRoomPrefs {
  if (!isStr(sessionId, MAX_SESSION_ID) || !Number.isSafeInteger(at) || at <= 0) return prefs;
  const s = prefs.session;
  if (!s) return next(prefs, { session: { id: sessionId, floor: at } });
  if (s.id !== sessionId || at <= s.floor) return prefs;
  return next(prefs, { session: { id: s.id, floor: at } });
}

/**
 * Forget the session, so the next Start mints a fresh id.
 *
 * This is the eviction path. Rotating is stronger than the watermark: every grant
 * ever issued under the old id becomes inert at the sessionId gate, which is what
 * keeps "evicted is terminal for this session" true once a session can outlive the
 * process that created it. The visible cost is that everyone's address changes
 * after a removal.
 */
export function rotateSession(prefs: LanRoomPrefs): LanRoomPrefs {
  if (!prefs.session) return prefs;
  return next(prefs, { session: undefined });
}

/**
 * Replace the remembered picks with what the host just admitted. Self is dropped
 * (the host is not an admit target — it self-admits inside the session), the list
 * is de-duplicated and capped, and pick ORDER is preserved so the picker's
 * pre-selection reads back the way the host built it.
 */
export function withPicks(prefs: LanRoomPrefs, ids: readonly string[], selfId?: string): LanRoomPrefs {
  const picks: string[] = [];
  for (const id of ids) {
    if (!isStr(id, MAX_MEMBER_ID) || id === selfId || picks.includes(id)) continue;
    picks.push(id);
    if (picks.length >= LAN_MAX_PICKS) break;
  }
  return next(prefs, { picks });
}

/** Host admitted one more member into a LIVE session — remember them too, so the
 *  next Start offers the group that actually played rather than the group that
 *  was picked before the last two people showed up. */
export function addPick(prefs: LanRoomPrefs, memberId: string, selfId?: string): LanRoomPrefs {
  if (!isStr(memberId, MAX_MEMBER_ID) || memberId === selfId) return prefs;
  if (prefs.picks.includes(memberId)) return prefs;
  if (prefs.picks.length >= LAN_MAX_PICKS) return prefs;
  return next(prefs, { picks: [...prefs.picks, memberId] });
}

/**
 * Host evicted a member (or they left the room). Forgetting them is not a nicety:
 * an evict is a deliberate "not this person", and re-offering them pre-ticked at
 * the next Start would quietly undo it — the admit itself is signed and would go
 * through, since `evicted` is in-memory and dies with the session.
 */
export function removePick(prefs: LanRoomPrefs, memberId: string): LanRoomPrefs {
  if (!prefs.picks.includes(memberId)) return prefs;
  return next(prefs, { picks: prefs.picks.filter((p) => p !== memberId) });
}

/** Remember a game whose firewall rule the helper just created. Most-recent
 *  first, so the cap evicts the game nobody has launched in months. */
export function addApp(prefs: LanRoomPrefs, exe: string): LanRoomPrefs {
  if (!isStr(exe, MAX_APP_PATH)) return prefs;
  if (prefs.apps.length > 0 && samePath(prefs.apps[0], exe)) return prefs; // already most recent
  const rest = prefs.apps.filter((p) => !samePath(p, exe));
  return next(prefs, { apps: [exe, ...rest].slice(0, LAN_MAX_APPS) });
}

/**
 * Forget a game. Called when a re-apply is REFUSED — the .exe was uninstalled or
 * moved, and a path that can no longer be granted must not keep costing a
 * round-trip (and a log line) at every single session start.
 */
export function removeApp(prefs: LanRoomPrefs, exe: string): LanRoomPrefs {
  const apps = prefs.apps.filter((p) => !samePath(p, exe));
  if (apps.length === prefs.apps.length) return prefs;
  return next(prefs, { apps });
}

/** Cheap equality so a no-op write never touches the disk (the store writes
 *  synchronously; a Start that changed nothing should cost nothing). */
export function sameLanPrefs(a: LanRoomPrefs, b: LanRoomPrefs): boolean {
  return a.picks.length === b.picks.length
    && a.apps.length === b.apps.length
    && a.session?.id === b.session?.id
    && a.session?.floor === b.session?.floor
    && a.picks.every((v, i) => v === b.picks[i])
    && a.apps.every((v, i) => v === b.apps[i]);
}

/**
 * What the picker should open with: the remembered picks INTERSECTED with who is
 * actually selectable right now, in remembered order, capped.
 *
 * The intersection is the point. A remembered pick may have left the room, been
 * evicted, or (in the invite-into-a-live-session case) already be admitted — and
 * a pre-ticked tile that does not exist in the grid would be an invisible
 * selection the host cannot see or undo, which then travels into a signed admit.
 */
export function preselectPicks(
  picks: readonly string[],
  candidateIds: readonly string[],
  cap: number = LAN_MAX_PICKS,
): string[] {
  if (cap <= 0) return [];
  const available = new Set(candidateIds);
  const out: string[] = [];
  for (const id of picks) {
    if (!available.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}
