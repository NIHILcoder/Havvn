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
 * FROZEN-WIRE WARNING: the 5 signed gossip interfaces below (LanGenesisMsg /
 * LanStateMsg / LanSignalMsg / LanAdmitMsg / LanEvictMsg) describe messages whose
 * signatures are computed over a domain-tagged canonical with a FROZEN field
 * order (see shared/lan-protocol.ts). NEVER append a field to a signed type —
 * it breaks older peers' signatures (the `deafened` lesson). A v2 field rides a
 * new domain tag or travels OUTSIDE the signed canonical.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Signed gossip message arms (spread into the engine's `Msg` union at
//    room-engine.ts ~103). Every arm carries `pub` + `sig` and is verified with
//    the existing verifySignedBy over the matching lan-*Canonical builder.
//
//    DOMAIN SPLIT (plan §0.1 #2/#7): the DURABLE authority triple
//    (lan-genesis / lan-admit / lan-evict) binds `sessionId` — a rekey-stable
//    anchor that never rotates on kick, so no re-mint in applyLocalRekey is
//    needed. The TRANSIENT pair (lan-state / lan-signal) binds `room.topic`
//    exactly like voice-state / voice-signal and survives rekey via reannounce.
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

/** Convenience union of the 5 signed LAN gossip arms (for exhaustive handling). */
export type LanMsg =
  | LanGenesisMsg
  | LanStateMsg
  | LanSignalMsg
  | LanAdmitMsg
  | LanEvictMsg;

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
  /** OUR link quality (Phase 2); absent in beta. */
  quality?: LanQuality;
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
  | 'bad-adapter-name'; // validateAdapterName rejected a VPN-ish name

/** Control-plane messages multiplexed over the helper pipe. */
export type LanControlMsg =
  | { t: 'hello'; token: string; proto: number } // engine→helper, MUST be first frame
  | { t: 'ready'; adapter: string; vip: number; subnetBase: number; prefix: number } // helper→engine after net setup
  | { t: 'error'; code: LanHelperErrorCode; message: string } // helper→engine fatal error
  | { t: 'reip'; vip: number; gen: number } // engine→helper on vIP collision loss
  | { t: 'shutdown' } // engine→helper cooperative teardown
  | { t: 'ping' }
  | { t: 'pong' }; // over-pipe heartbeat (independent of the PID watchdog)

// ─────────────────────────────────────────────────────────────────────────────
// 6. Shared constants.
// ─────────────────────────────────────────────────────────────────────────────

/** Mesh cap — bounds fan-out AND how many peers a hostile keyholder can force us
 *  to build (checked in LanSession.ensurePeer). Mirror in the renderer next to
 *  VOICE_MESH_LIMIT (RoomsPage.tsx:41). Other mesh caps (MAX_PENDING_ICE,
 *  MAX_ANTIREPLAY, LAN_MTU, DEFAULT_LAN_BUCKET) live in shared/lan-session-core.ts;
 *  that module should import MAX_LAN_PEERS from here rather than redefine it. */
export const MAX_LAN_PEERS = 8;
