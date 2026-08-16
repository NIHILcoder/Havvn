/**
 * Shared TypeScript contract for the Havvn Virtual-LAN feature (plan
 * havvn-virtual-lan.md). This is the ONE type module every process imports —
 * the engine window (room-engine / room-lan), the main process (lan-manager),
 * the elevated helper (helper-main / pipe-bridge), and the renderer — so it MUST
 * stay dependency-free: no electron, no node:crypto, no runtime side-effects.
 * Only ambient globals `Buffer` (Node, also polyfilled everywhere lan-frame.ts
 * runs) and DOM `RTCIceServer`/`RTCDataChannel` (type-only; lib.dom is in tsconfig,
 * mirrors how room-voice.ts:94 types VoiceAdapter.iceServers) appear here — never
 * an imported value. This mirrors the dependency invariant of shared/lan-ip.ts /
 * lan-packet.ts / lan-frame.ts.
 *
 * FROZEN-WIRE WARNING: the 6 signed gossip interfaces below (LanGenesisMsg /
 * LanStateMsg / LanSignalMsg / LanAdmitMsg / LanEvictMsg / LanReachMsg) describe
 * messages whose signatures are computed over a domain-tagged canonical with a
 * FROZEN field order (see shared/lan-protocol.ts). NEVER append a field to a
 * signed type — it breaks older peers' signatures (the `deafened` lesson). A v2
 * field rides a new domain tag or travels OUTSIDE the signed canonical.
 * `lan-reach` (Phase 2B) is exactly that discipline applied: a NEW arm with its
 * OWN tag, never a field bolted onto lan-state.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Signed gossip message arms (spread into the engine's `Msg` union at
//    room-engine.ts ~103). Every arm carries `pub` + `sig` and is verified with
//    the existing verifySignedBy over the matching lan-*Canonical builder.
//
//    DOMAIN SPLIT (plan §0.1 #2/#7): the DURABLE authority triple
//    (lan-genesis / lan-admit / lan-evict) binds `sessionId` — a rekey-stable
//    anchor that never rotates on kick, so no re-mint in applyLocalRekey is
//    needed. The TRANSIENT trio (lan-state / lan-signal / lan-reach) binds
//    `room.topic` exactly like voice-state / voice-signal and survives rekey via
//    reannounce.
// ─────────────────────────────────────────────────────────────────────────────

/** WebRTC signaling verb for the LanPeer mesh (offer/answer/ice). */
export type LanSignalKind = 'offer' | 'answer' | 'ice';

/**
 * Signed session genesis (plan §0.1 #7). `by` = the creator's memberId = the
 * pinned hostId; the signature is over lanGenesisCanonical(sessionId, {by, at}).
 * First-writer-wins per sessionId: a later genesis naming a DIFFERENT `by` for the
 * same sessionId is rejected. The pinned hostId is the trust root every
 * lan-admit / lan-evict verifies against. Signed BY `by` (host) so the existing
 * ban-gate covers a banned host for free.
 */
export interface LanGenesisMsg {
  t: 'lan-genesis';
  /** Host-chosen session id; RECOMMENDED format `${by}.${16hexRandom}`. */
  sessionId: string;
  /** Host / creator memberId — becomes the pinned hostId (ban-gate keys on `by`). */
  by: string;
  /** Creation clock; future-cutoff only (no monotonic floor — the pin is immutable). */
  at: number;
  /** Host Ed25519 pubkey (PEM); memberId === sha256(pub) enforced by verifySignedBy. */
  pub: string;
  /** Ed25519 over lanGenesisCanonical(sessionId, {by, at}). */
  sig: string;
}

/**
 * Presence + vIP claim (analog of voice-state). Broadcast for discoverability;
 * transient → bound to room.topic and re-announced on hello. The vIP is a CLAIM:
 * verified on receipt against deriveVip(sessionId, memberId, gen) (plan §0.1 #6).
 * Only ADMITTED members' verified claims enter the routing table
 * (resolveVipOwners); a non-admitted member's lan-state shows join-intent only.
 * Signed BY `memberId` (sender) so the ban-gate covers a banned sender.
 */
export interface LanStateMsg {
  t: 'lan-state';
  /** Sender (ban-gate key + per-member lastLanStateAt anti-replay floor key). */
  memberId: string;
  /** Which session this presence is for (bound in the canonical). */
  sessionId: string;
  /** Claimed uint32 virtual IP inside the session /16. */
  vip: number;
  /** Collision-arbitration generation, bumped by the loser; 0..0xffff. */
  gen: number;
  /** Monotonic per-member presence clock (own lastLanStateAt floor). */
  at: number;
  pub: string;
  /** Ed25519 over lanStateCanonical(room.topic, m). */
  sig: string;
}

/**
 * Targeted WebRTC signaling for the LanPeer mesh (analog of voice-signal).
 * Transient → bound to room.topic; carries NO `at` (perfect-negotiation + DTLS
 * make a replayed/out-of-order offer/answer/ice inert — same as voice-signal).
 * Dropped from any non-admitted memberId BEFORE ensurePeer (plan §0.1 #1).
 * Signed BY `memberId` (sender).
 */
export interface LanSignalMsg {
  t: 'lan-signal';
  /** Sender; MUST be in admittedSet or this is dropped pre-mesh. */
  memberId: string;
  /** Addressed peer; must === self.memberId to be handled. */
  to: string;
  kind: LanSignalKind;
  /** SDP / ICE blob (structured; unclamped — bounded only by MAX_FRAME_CHARS). */
  data: unknown;
  pub: string;
  /** Ed25519 over lanSignalCanonical(room.topic, m). */
  sig: string;
}

/**
 * Host admits a member into the session (authority class of e2eCfg, but
 * rekey-stable by construction: signed over sessionId, which never rotates —
 * plan §0.1 #2, so NO re-mint in applyLocalRekey is required). Populates
 * admittedSet, the ONLY thing that lets ensurePeer build a LanPeer. Signed BY
 * `by` (host) which MUST === the pinned genesis hostId.
 */
export interface LanAdmitMsg {
  t: 'lan-admit';
  sessionId: string;
  /** Host memberId — MUST === pinned hostId from lan-genesis (ban-gate keys on `by`). */
  by: string;
  /** Admitted memberId (added to admittedSet). */
  member: string;
  /** Monotonic per-`member` admit clock (own lastLanAdmitAt floor). */
  at: number;
  pub: string;
  /** Ed25519 over lanAdmitCanonical(sessionId, {by, member, at}). */
  sig: string;
}

/**
 * Host evicts a member. TERMINAL for (session, member): evictedSet is sticky and
 * beats admittedSet, so a replayed old admit can never re-admit and admit/evict
 * keep SEPARATE monotonic floors (no shared-floor bug). Frees the member's
 * vIP/route everywhere. Signed BY `by` (host) which MUST === pinned hostId.
 */
export interface LanEvictMsg {
  t: 'lan-evict';
  sessionId: string;
  /** Host memberId — MUST === pinned hostId. */
  by: string;
  /** Evicted memberId (added to evictedSet, removed from admittedSet). */
  member: string;
  /** Monotonic per-`member` evict clock (own lastLanEvictAt floor). */
  at: number;
  pub: string;
  /** Ed25519 over lanEvictCanonical(sessionId, {by, member, at}). */
  sig: string;
}

/**
 * Phase 2B — signed REACHABILITY advert: "these are the admitted members I
 * currently hold a CONNECTED direct leg to, and here is whether I am willing to
 * forward for others". The single input the one-hop peer-relay selector needs.
 *
 * CLASS: presence, NOT authority. It grants nothing — admission still comes only
 * from a host-signed lan-admit, and a vIP is still a claim re-derived on receipt.
 * So it is TRANSIENT: anchored on room.topic (like lan-state / lan-signal /
 * voice-state), with `sessionId` carried INSIDE the canonical and re-checked on
 * receipt so a cross-session advert can never poison relay selection. It survives
 * a rekey by being RE-ANNOUNCED, never by being re-signed.
 *
 * ANTI-REPLAY: its OWN per-member monotonic floor (lastLanReachAt) — NEVER shared
 * with lastLanStateAt. A shared floor is the documented voice HIGH: one type's
 * fresh `at` would silently censor the other type's next message.
 *
 * WIRE CANONICAL FORM: `reach` MUST already be ascending, deduped and made of
 * 32-lowercase-hex memberIds. The receiver's clamp NORMALISES it, so a sender
 * that emits any other representation produces bytes the verifier will not
 * reproduce and its signature fails — deliberately: one representation on the
 * wire means no signature malleability and no duplicate gossip ids.
 *
 * Signed BY `memberId` (sender) so the existing ban-gate covers a banned sender.
 */
export interface LanReachMsg {
  t: 'lan-reach';
  /** Sender (ban-gate key + per-member lastLanReachAt anti-replay floor key). */
  memberId: string;
  /** Which session this reachability is for (bound INSIDE the canonical). */
  sessionId: string;
  /** Monotonic per-member reach clock (own lastLanReachAt floor). */
  at: number;
  /** Willing to spend OUR uplink forwarding for a pair that cannot connect
   *  directly (the `lanRelayEnabled` setting). false ⇒ never a relay candidate,
   *  but the advert still publishes reachability, which stays useful. */
  relay: boolean;
  /** memberIds we hold a CONNECTED direct leg to right now. CANONICAL FORM ONLY:
   *  ascending, deduped, /^[0-9a-f]{32}$/, at most MAX_LAN_REACH entries. */
  reach: string[];
  pub: string;
  /** Ed25519 over lanReachCanonical(room.topic, m). */
  sig: string;
}

/** Convenience union of the 6 signed LAN gossip arms (for exhaustive handling). */
export type LanMsg =
  | LanGenesisMsg
  | LanStateMsg
  | LanSignalMsg
  | LanAdmitMsg
  | LanEvictMsg
  | LanReachMsg;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Engine-side admission state the switch handlers / admission gate need. Lives
//    ON the LanSession (room.lan), mirroring how voice state lives on room.voice.
//    Admission is TERMINAL-EVICT: admittedSet is add-only, evictedSet is sticky
//    and beats admittedSet, so admit and evict keep SEPARATE per-member monotonic
//    `at` floors — never a shared floor.
// ─────────────────────────────────────────────────────────────────────────────

/** The pinned trust root for a session (first verified lan-genesis wins). */
export interface LanGenesisPin {
  hostId: string;
  at: number;
  pub: string;
  sig: string;
}

/** All the per-session admission + anti-replay bookkeeping. Each floor map is its
 *  OWN map (never shared between types) and FIFO-capped at MAX_ANTIREPLAY. */
export interface LanSessionAdmission {
  /** sessionId → pinned root (first-writer-wins). */
  genesis: Map<string, LanGenesisPin>;
  /** memberIds the host admitted to the active session (NOT roster membership). */
  admitted: Set<string>;
  /** Sticky terminal evictions (beat admitted). */
  evicted: Set<string>;
  /** Per-member presence anti-replay floor. */
  lastLanStateAt: Map<string, number>;
  /** Per-member admit anti-replay floor. */
  lastLanAdmitAt: Map<string, number>;
  /** Per-member evict anti-replay floor. */
  lastLanEvictAt: Map<string, number>;
  /** Per-member REACH anti-replay floor (Phase 2B). Its OWN map — sharing it
   *  with lastLanStateAt would let a fresh presence `at` censor the next
   *  reachability advert (and vice versa), the documented voice HIGH. */
  lastLanReachAt: Map<string, number>;
}

/**
 * A member's last accepted reachability advert, as the relay selector consumes it
 * (Phase 2B). Stored per memberId; `at` doubles as the freshness stamp so a
 * departed member's advert can expire out of the candidate set.
 */
export interface LanReachAdvert {
  /** The advert's monotonic clock — also its freshness stamp (TTL is applied by
   *  the selector, not here). */
  at: number;
  /** Willing to forward for others. false ⇒ excluded from every candidate set. */
  relay: boolean;
  /** Admitted members this member claims a connected direct leg to. */
  peers: ReadonlySet<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. RoomState.lan — how this install sees the room's LAN session. Session-only,
//    never persisted (mirrors RoomVoiceState); reaches the renderer wholesale via
//    buildState() → room-update → cache, with no merge. Consumed by shared/types.ts
//    (RoomState gains `lan: RoomLanState`).
// ─────────────────────────────────────────────────────────────────────────────

/** OUR link quality to a LAN peer (Phase 2 getStats; absent in beta). */
export type LanQuality = 'good' | 'fair' | 'poor';

/** OUR LanPeer connection state to a session member (from pc.connectionState).
 *  'failed' is the terminal symmetric-NAT case surfaced honestly (plan §12.7). */
export type LanPeerStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** ICE candidateType of one end of the selected pair (getStats). Structurally
 *  identical to shared/lan-quality.ts's LanCandidateType (the two are mutually
 *  assignable); this copy is the UI/state contract, that one is the mapper's. */
export type LanCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/** How frames actually travel: same physical LAN, hole-punched through NAT, or
 *  bounced off a TURN relay (which inflates RTT — worth saying out loud). */
export type LanPathKind = 'local' | 'nat' | 'relay' | 'unknown';

/**
 * WHY a leg has no usable path — the honest terminal message behind a 'failed'
 * peer (plan §12.7), derived from the GATHERED ICE candidate types because a
 * failed link has no selected pair left to inspect:
 *   • no-udp           — we never gathered a server-reflexive candidate: UDP/STUN
 *                        never left this machine (firewall / blocked outbound).
 *   • needs-turn       — both ends saw the internet, no pair ever succeeded and NO
 *                        relay is configured: the symmetric-NAT tail. The fix is a
 *                        TURN server (Settings → Connection), and because a room's
 *                        iceServers are fixed at session start, the LAN session
 *                        must be restarted afterwards.
 *   • symmetric-nat    — same, but TURN *is* configured and a relay path still
 *                        never came up (bad credentials / relay unreachable).
 *   • peer-unreachable — even a relayed pair failed; the peer is simply not there.
 *   • unknown          — never sampled; do NOT guess at a cause.
 */
export type LanIceFailReason = 'no-udp' | 'symmetric-nat' | 'needs-turn' | 'peer-unreachable' | 'unknown';

/** A member participating in the room's LAN session (includes self when active). */
export interface RoomLanParticipant {
  memberId: string;
  /** Dotted-quad virtual IP, populated ONLY from a claim verified via
   *  verifyVipClaim / resolveVipOwners (plan §0.1 #6). Empty until assigned. */
  vip: string;
  /** A host-signed lan-admit is present for this member — NOT roster membership. */
  admitted: boolean;
  /** OUR LanPeer connection state to them; 'connecting' until first negotiated. */
  status: LanPeerStatus;
  // ── Phase 2A: measured link facts (one getStats poll every ~3s). Every field
  //    below is ABSENT until actually measured — an absent `quality` means "no
  //    dot at all", never "good" (voice's never-connected rule). Self carries
  //    none of them (self has no LanPeer, so nothing to measure).
  /** OUR link quality to them (voice's ladder: RTT 200/400ms, loss 3%/8%). */
  quality?: LanQuality;
  /** Selected-pair round-trip time in ms (rounded). */
  rttMs?: number;
  /** ICE-consent loss proxy, PERCENT 0..100 (a data-only PC has no RTP loss). */
  lossPct?: number;
  /** OUR OWN send-drop rate, PERCENT 0..100 (channel closed / over the send HWM).
   *  Display-only: deliberately not an input to the quality ladder. */
  dropPct?: number;
  /** candidateType of OUR end of the selected pair. */
  candidate?: LanCandidateType;
  /** candidateType of THEIR end of the selected pair. */
  remoteCandidate?: LanCandidateType;
  /** Local / NAT-traversed / TURN-relayed. */
  path?: LanPathKind;
  /** The link connected before and is re-establishing right now. */
  reconnecting?: boolean;
  /** Latched explanation of the last connection failure — kept across the
   *  reap/rebuild churn so the honest message does not flicker. */
  failReason?: LanIceFailReason;
  /** Reconnect attempts exhausted: this leg is terminally dead (not "connecting
   *  forever"). Pairs with failReason to explain WHY and point at the fix. */
  terminal?: boolean;
  // ── Phase 2B: one-hop peer relay. Both fields follow the absent-unless-true
  //    discipline above, and NEITHER widens LanPeerStatus — a relayed leg keeps
  //    its honest direct status (terminal 'failed'), and the UI keys off
  //    `relayVia` to render "connected through <name>" instead of the red
  //    no-path block. Widening the status union would silently reshape every
  //    exhaustive Record<LanPeerStatus, …> (RoomLanPanel's STATUS_CLASS,
  //    lan-quality's tally) for a purely cosmetic gain.
  /** memberId of the peer currently forwarding this leg's traffic for us. Present
   *  ⇒ the pair IS playable despite `terminal`. NOTE for the UI: any quality /
   *  rttMs shown alongside this is measured to the RELAY, not end-to-end — say so
   *  in the tooltip rather than passing it off as the pair's quality. */
  relayVia?: string;
  /** Round-trip through the relay in ms — the ONLY end-to-end number a relayed
   *  pair has, because getStats can see no further than our leg to the relay.
   *  Absent until actually measured; never synthesised from the two legs. */
  relayRttMs?: number;
  /** This member's own advertised willingness to relay for others (from their
   *  signed lan-reach). Informational only — never an authorisation. */
  relayWilling?: boolean;
}

/** The room's LAN session as this install sees it. */
export interface RoomLanState {
  /** koffi + wintun.dll loaded AND platform win32 — Start is offerable. */
  available: boolean;
  /** A LAN session is running in THIS room. */
  active: boolean;
  /** Another room already holds the single global session (beta: Start greyed here). */
  blocked?: boolean;
  /** Per-session scope id (adapter name / subnet / firewall alias key off this). */
  sessionId?: string;
  /** OUR virtual IP once assigned + verified (dotted-quad). */
  selfVip?: string;
  /** The session /16 for display, e.g. '100.88.0.0/16'. */
  subnet?: string;
  /** Pinned session-genesis host memberId (every lan-admit verifies against it). */
  hostId?: string;
  /** WE own the session (created it) — may admit/evict. */
  isHost: boolean;
  /** The host has admitted US: on a passive (not-yet-active) session this means
   *  "invited — the Accept action is offerable". The join gate. */
  selfAdmitted?: boolean;
  /** Networking torn down by the VPN kill-switch. */
  suspended?: boolean;
  /** A turn:/turns: entry is present in the room's iceServers. Decides whether a
   *  failed leg should read "add a TURN server" or "TURN is configured and the
   *  path still failed" — the room's iceServers are fixed at session start, so a
   *  TURN change only takes effect for a session started afterwards. */
  turnConfigured?: boolean;
  /** THIS install is willing to forward traffic for a pair that cannot connect
   *  directly (the `lanRelayEnabled` setting, absent ⇒ treat as on). Phase 2B.
   *  PRIVACY: relaying is a plaintext waypoint — the per-leg DTLS terminates on
   *  the relay, so a relaying install can read the pair's LAN packets. That fact
   *  belongs in the toggle's user-visible description, not only here. */
  relayEnabled?: boolean;
  /** Distinct originators WE forwarded for recently (~10s window) — the visible
   *  "Relaying for N" indicator required by the bandwidth-cost invariant. Absent
   *  or empty ⇒ we are not currently spending uplink for anyone. */
  relayFor?: string[];
  /** Admitted peers plus self when active. */
  participants: RoomLanParticipant[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LanAdapter — the seam the engine (createLanSession) provides to a LanSession,
//    modeled on VoiceAdapter (room-voice.ts:92). Emitters sign + gossip the 5
//    types; sendPacket / onPacket bridge the elevated-helper named pipe. Type-only
//    RTCIceServer / Buffer references keep this import-time-clean (no browser/RTC
//    VALUE at module scope) so node vitest can import it, mirroring room-voice.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface LanAdapter {
  selfId: string;
  iceServers: RTCIceServer[];
  sessionId: string;
  /** true iff THIS install is the pinned genesis host (may admit / evict). */
  isHost: boolean;
  /** Signed 'lan-signal' to ONE member (offer/answer/ice); transient, topic-bound. */
  sendSignal(to: string, kind: LanSignalKind, data: unknown): void;
  /** Signed 'lan-state' broadcast: our presence + vIP claim. `at` monotonic. */
  announce(vip: number, gen: number, at: number): void;
  /** Host-only durable grant: signed 'lan-admit' for memberId. */
  admit(memberId: string, at: number): void;
  /** Host-only: signed 'lan-evict' — releases a member's vIP/route everywhere. */
  evict(memberId: string, at: number): void;
  /** Host-only ONCE at session create: signed 'lan-genesis' over sessionId. */
  genesis(): void;
  /** The session's admit/evict anti-replay watermark advanced — persist it against
   *  this sessionId. Reusing a session id across restarts (which is what keeps
   *  vIPs stable) is safe only because the next run seeds its floors from this
   *  number; see LanSessionCore.floorSeed and shared/lan-prefs.ts.
   *
   *  ⚠ MIRROR of LanAdapter in electron/sharing/room-lan.ts (~147). */
  persistFloor(at: number): void;
  /** Signed 'lan-reach' broadcast (Phase 2B): our currently-connected legs +
   *  relay willingness. `peers` MUST be pre-normalised (normalizeReachList) or
   *  the receiver's normalising clamp will not reproduce our signed bytes. `at`
   *  monotonic, on its OWN floor.
   *  ⚠ The IMPLEMENTED copy of this interface lives in
   *  electron/sharing/room-lan.ts (~92) — this one is the shared spec. Adding
   *  reach() there (and to createLanSession's adapter literal in room-engine.ts)
   *  is the next Phase-2B slice; until then the two copies differ by exactly
   *  this method, on purpose. */
  reach(peers: string[], relay: boolean, at: number): void;
  /** Inject an inbound (peer→us) IP frame into the local TUN via the helper pipe. */
  sendPacket(frame: Buffer): void;
  /** Register the TUN-egress router: the pipe-read loop calls handler per raw frame. */
  onPacket(handler: (frame: Buffer) => void): void;
  /** LAN state changed — engine rebuilds + pushes RoomState to the UI. */
  onChange(): void;
  warn(msg: string): void;
  log(msg: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Helper ↔ engine control plane. These messages ride the SAME named pipe as
//    the raw IPv4 data (multiplexed by a 1-byte channel discriminator in
//    electron/lan/pipe-bridge.ts) — never a second TCP port (no UAC-window
//    TOCTOU, plan §5). Pure type union so both the helper and the engine import
//    it from here.
// ─────────────────────────────────────────────────────────────────────────────

/** Tagged reasons a helper setup/runtime step can fail. */
export type LanHelperErrorCode =
  | 'not-elevated' // High-IL assertion failed (exit 3)
  | 'driver' // WintunCreateAdapter / StartSession failed
  | 'ip-config' // New-NetIPAddress / MTU / route step failed
  | 'firewall' // New-NetFirewallRule step failed
  | 'bad-token' // hello token mismatch (also destroys the pipe)
  | 'bad-adapter-name' // validateAdapterName rejected a VPN-ish name
  | 'bad-app-path'; // validateGameExePath rejected a renderer-supplied .exe path

/** Elevated-side facts the helper reports for the connectivity diagnostics (§11
 *  Phase 2A). MIRROR of the interface in electron/lan/pipe-bridge.ts. */
export interface LanHelperFacts {
  adapterName: string;
  /**
   * Whether the elevated PowerShell probe actually COMPLETED. When false, every
   * probed field below is ABSENT and diagnostics must render 'unknown' — a probe
   * that failed to run is not evidence that the adapter/IP/rules are gone, and
   * reporting it as such would accuse a healthy tunnel of being torn down.
   */
  probed?: boolean;
  adapterPresent?: boolean;
  adapterUp?: boolean;
  adapterStatus: string;
  ipAddresses: string[];
  expectedVip: string;
  subnet: string;
  mtu?: number;
  firewallRules?: string[];
  appRules: string[];
  driverVersion: string;
  ringActive: boolean;
  helperPid: number;
  uptimeMs: number;
}

/**
 * Control-plane messages multiplexed over the helper pipe.
 *
 * ⚠ DUPLICATED VERBATIM in electron/lan/pipe-bridge.ts (the copy the helper and
 * LanPipeClient actually import). Any new arm MUST land in BOTH in the same
 * commit or the two silently drift. The Phase-2A request/response arms carry an
 * `id` correlation number (uint32) — the Phase-1 verbs were fire-and-forget and
 * the pipe has no other correlation mechanism.
 */
export type LanControlMsg =
  | { t: 'hello'; token: string; proto: number } // engine→helper, MUST be first frame
  | { t: 'ready'; adapter: string; vip: number; subnetBase: number; prefix: number } // helper→engine after net setup
  | { t: 'error'; code: LanHelperErrorCode; message: string } // helper→engine fatal error
  | { t: 'reip'; vip: number; gen: number } // engine→helper on vIP collision loss
  | { t: 'shutdown' } // engine→helper cooperative teardown
  | { t: 'ping' }
  | { t: 'pong' } // over-pipe heartbeat (independent of the PID watchdog)
  // ── Phase 2A (§11) — request/response, correlated by `id` ──────────────────
  | { t: 'allow-app'; id: number; exe: string } // engine→helper, scoped per-game allow-rule
  | { t: 'allow-app-result'; id: number; ok: boolean; rule?: string; code?: LanHelperErrorCode; message?: string }
  | { t: 'diag'; id: number } // engine→helper, zero-input fact collection
  | { t: 'diag-result'; id: number; facts: LanHelperFacts };

// ─────────────────────────────────────────────────────────────────────────────
// 6. Shared constants.
// ─────────────────────────────────────────────────────────────────────────────

/** Mesh cap — bounds fan-out AND how many peers a hostile keyholder can force us
 *  to build (checked in LanSession.ensurePeer). Mirror in the renderer next to
 *  VOICE_MESH_LIMIT (RoomsPage.tsx:41). Other mesh caps (MAX_PENDING_ICE,
 *  MAX_ANTIREPLAY, LAN_MTU, DEFAULT_LAN_BUCKET) live in shared/lan-session-core.ts;
 *  that module should import MAX_LAN_PEERS from here rather than redefine it. */
export const MAX_LAN_PEERS = 8;

/** Cap on a lan-reach advert's `reach` array. Equals MAX_LAN_PEERS because a
 *  member can hold no more legs than the mesh cap allows — so an advert claiming
 *  more is provably lying and the clamp truncates it (which breaks its signature
 *  at verify, exactly as intended). */
export const MAX_LAN_REACH = MAX_LAN_PEERS;
