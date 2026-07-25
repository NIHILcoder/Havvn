/**
 * Virtual-LAN session for a room — the WebRTC transport + routing brain of the
 * Havvn Virtual-LAN feature (plan §2/§4). Runs in the hidden room-engine renderer
 * (a Chromium context, so it has native RTCPeerConnection). Each ADMITTED session
 * member holds a dedicated data RTCPeerConnection to every other admitted member;
 * raw IP frames from the elevated Wintun helper are classified and routed over
 * those channels. This module is the "routing brain": the helper stays a dumb
 * ring↔pipe shovel with zero protocol logic.
 *
 * ─ WHY THIS IS A CLONE OF THE VOICE TRANSPORT, NOT THE VOICE AUTHORIZATION ─
 * The perfect-negotiation machinery (polite = selfId > memberId, pendingIce
 * buffer, onPeerFailed reap/rebuild) is lifted from room-voice.ts's MediaPeer/
 * VoiceSession because that transport pattern is proven. But voice is open to
 * every room member by design (onPeerState/onSignal admit any self-announcer);
 * LAN is HOST-GATED. So the admission surface is DELIBERATELY DIFFERENT:
 *
 *   • The admission gate lives INSIDE ensurePeer + onSignal (must-fix #1):
 *     a LanPeer is built ONLY for a member the host has admitted (core.isAdmitted,
 *     populated solely from a verified host-signed lan-admit). lan-signal from a
 *     non-admitted member is dropped BEFORE ensurePeer. Roster membership is
 *     necessary-but-NOT-sufficient — a rostered-but-unadmitted keyholder is
 *     physically unable to force a LanPeer/RTCDataChannel.
 *   • The one data channel is out-of-band negotiated on BOTH sides (must-fix #4):
 *     createDataChannel('lan', {negotiated:true, id:0, ordered:false,
 *     maxRetransmits:0}). Never the default in-band channel (that needs
 *     pc.ondatachannel and would drop inbound frames).
 *   • Routing resolves vIP → memberId → LanPeer AT SEND TIME, never caching a
 *     channel/peer ref (onPeerFailed reap invalidates them; a stale-open ref
 *     silently black-holes).
 *
 * ─ PHASE 2B: ONE-HOP PEER RELAY (this file is the transport half) ───────────
 * When a pair both sit behind symmetric NAT with no TURN, Phase 2A latches the
 * leg TERMINAL and honestly says so — but the pair still cannot play. Phase 2B
 * forwards their frames through a third ADMITTED member that holds a working leg
 * to both. All of the POLICY is pure and lives in shared/lan-relay.ts (envelope
 * codec, the two data-plane decisions, the deterministic advert-only selector);
 * this file contributes only the four things a pure module cannot do:
 *
 *   • ADVERTISE our own reachability — the sorted set of members we hold a
 *     CONNECTED leg to, plus our willingness bit — as the signed `lan-reach`
 *     gossip arm, emitted on CHANGE with a 3 s floor and a 30 s refresh (both
 *     ride the existing quality-poll tick, so no second timer and no storm).
 *   • ROUTE a terminal peer's traffic through the argmin relay, including
 *     BROADCAST: a terminal peer has been reaped out of `peers`, so the relayed
 *     members are unioned into RouteCtx.peerIds or LAN game discovery would
 *     silently never reach them.
 *   • FORWARD for others when we are the chosen relay, under budgets that are
 *     entirely separate from the proven per-peer direct bucket, and only while
 *     the relay toggle is on (read LIVE, so switching it off stops forwarding on
 *     the very next packet rather than at the next advert).
 *   • INVALIDATE the selection whenever an input changes (advert, leg status,
 *     admit, evict, departure, willingness, teardown). The route cache holds a
 *     memberId ONLY — never a LanPeer/RTCDataChannel, which is the exact
 *     stale-ref black hole documented above.
 *
 * ONE HOP is enforced structurally in shared/lan-relay.ts (a relay may forward
 * only a frame that arrived on the channel of the member named in `origin`, which
 * a twice-travelled frame can never satisfy) — there is no hop counter here to
 * get wrong. PRIVACY: relaying is a plaintext waypoint; the per-leg DTLS
 * terminates on the relay, so a relaying install can read the pair's LAN packets.
 * That must be said in the toggle's user-visible description, not only in code.
 *
 * ALL policy/state (genesis pinning, admittedSet, the verified vIP→member table,
 * per-type anti-replay floors, per-peer token buckets) lives in the pure,
 * node-testable shared/lan-session-core.ts; route planning lives in the pure
 * shared/lan-router.ts and relay policy in shared/lan-relay.ts. This file is only
 * the RTCPeerConnection wiring around them. RTCPeerConnection is referenced ONLY
 * inside class bodies (never at module import time) so node vitest can import the
 * file and drive it with a fake adapter.
 */

import { LanSessionCore, MAX_LAN_PEERS, MAX_PENDING_ICE, LAN_RELAY_TOTAL_MEMBER } from '../../shared/lan-session-core';
import type { LanStateClaim } from '../../shared/lan-session-core';
import { planRoute, acceptInbound } from '../../shared/lan-router';
import type { RouteCtx } from '../../shared/lan-router';
import {
  LanReachTable, MAX_RELAY_FRAME, LAN_REACH_MIN_INTERVAL_MS, LAN_REACH_REFRESH_MS,
  encodeRelayFrame, decodeRelayFrame, isRelayFrame,
  planRelayForward, acceptRelayedInbound, relayEligible, selectRelay,
} from '../../shared/lan-relay';
import type { LanRelayView } from '../../shared/lan-relay';
// The emitter MUST produce the same canonical form the receiver's clampLanReach
// normalises to, so it calls the very same function rather than a local sort.
import { normalizeReachList } from '../../shared/lan-protocol';
import { sessionSubnet, vipToString } from '../../shared/lan-ip';
import type { SubnetInfo } from '../../shared/lan-ip';
import {
  LAN_QUALITY_POLL_MS, reduceLanStats, stunDelta, windowedLoss, classifyLanQuality,
  isMeasured, explainIceFailure, hasTurn, linkQualityChanged, lossToPct,
} from '../../shared/lan-quality';
import type {
  LanRawStat, LanStatsSnapshot, LanStunCounters, LanLossSample, LanLinkQuality, LanDiagPeer,
} from '../../shared/lan-quality';
import type {
  RoomLanState, RoomLanParticipant, LanPeerStatus, LanIceFailReason,
} from '../../shared/lan-types';

export type LanSignalKind = 'offer' | 'answer' | 'ice';

/** DROP backpressure threshold (plan §2): once the channel's send buffer exceeds
 *  this, further frames are dropped rather than queued — a game tunnel wants drop,
 *  queueing degrades unreliable into reliable-with-lag. Precedent: remote-cast
 *  streamTo HIGH_WATER. */
const LAN_SEND_HWM = 256 * 1024;

/**
 * How many times a leg may be reaped-and-rebuilt after 'failed' before we call it
 * TERMINAL and stop (plan §12.7, Phase 2A item B).
 *
 * Without this bound onPeerFailed re-creates the peer instantly and a
 * symmetric-NAT pair oscillates connecting→failed→connecting forever: the tile
 * never settles on 'failed', so the honest "no direct path — configure a TURN
 * server" message can never be shown and the leg merely looks slow. Three
 * attempts is enough to ride out a one-off ICE hiccup and short enough that a
 * genuinely unreachable peer stops burning candidates within ~a minute.
 */
const LAN_MAX_PEER_REBUILDS = 3;

/**
 * How long an originator we forwarded a frame for keeps counting toward the
 * visible "Relaying for N" indicator (Phase 2B). Damped rather than instantaneous
 * on purpose: an advert-lag window can make two ends briefly pick different
 * relays, and a badge reflecting the literal last packet would strobe.
 */
const LAN_RELAY_SERVED_WINDOW_MS = 10_000;

/** Bound on the served-origins map (it is keyed by ADMITTED members only, so
 *  MAX_LAN_PEERS is already the real ceiling — this is belt-and-braces). */
const LAN_MAX_RELAY_SERVED = 32;

/** One poll's reading of a leg: the raw getStats snapshot plus the two derived
 *  rates that need per-peer history (smoothed consent loss, our own send-drop). */
interface LanPeerSample {
  snap: LanStatsSnapshot;
  /** Smoothed ICE-consent loss over LAN_LOSS_WINDOW_MS, fraction 0..1. */
  loss: number;
  /** OUR send-drop fraction since the previous poll, 0..1. */
  dropPct: number;
}

/**
 * What the engine (createLanSession in room-engine.ts) provides to a LanSession —
 * models VoiceAdapter (room-voice.ts:92). The emit* methods sign + gossip the
 * matching lan-* type; sendPacket/onPacket bridge the elevated helper's named
 * pipe. No browser globals are referenced here, so the interface is import-safe.
 */
export interface LanAdapter {
  selfId: string;
  iceServers: RTCIceServer[];
  sessionId: string;
  /** true iff THIS install is the pinned genesis host (may admit/evict). */
  isHost: boolean;
  /** Signed 'lan-signal' to ONE member (offer/answer/ice); transient, topic-bound. */
  sendSignal(to: string, kind: LanSignalKind, data: unknown): void;
  /** Signed 'lan-state' broadcast: our presence + vIP claim. `at` monotonic. */
  announce(vip: number, gen: number, at: number): void;
  /** Host-only durable grant: signed 'lan-admit' for memberId (re-minted on rekey). */
  admit(memberId: string, at: number): void;
  /** Host-only: signed 'lan-evict' — releases a member's vIP/route everywhere. */
  evict(memberId: string, at: number): void;
  /** Re-assign OUR Wintun adapter IP after a vIP collision loss: sends a {t:'reip'}
   *  control message down the helper pipe so the adapter owns the new vip. Without
   *  this the collision loser's adapter keeps the stale IP → egress src-spoof-drops
   *  and ingress is undeliverable (must-fix #6, HIGH). */
  reip(vip: number, gen: number): void;
  /** Host-only ONCE at session create: signed 'lan-genesis' over sessionId (pins host). */
  genesis(): void;
  /**
   * Phase 2B — signed 'lan-reach' broadcast: the members we currently hold a
   * CONNECTED direct leg to, plus whether we are willing to forward for others.
   * TRANSIENT (topic-bound like lan-state), its OWN monotonic `at` floor, and
   * `peers` arrives ALREADY in canonical wire form (normalizeReachList) because
   * the receiver's clamp normalises — any other representation produces bytes the
   * verifier cannot reproduce and the signature fails by design.
   *
   * ⚠ MIRROR of LanAdapter in shared/lan-types.ts (~398). The two copies must
   * gain a method in the SAME commit or they silently drift.
   */
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

/**
 * One data connection to one admitted peer (perfect negotiation). The single
 * data channel is out-of-band negotiated on BOTH sides so no DCEP / ondatachannel
 * is involved; perfect negotiation governs ONLY the SDP/SCTP m-line.
 */
class LanPeer {
  private pc: RTCPeerConnection;
  private ch: RTCDataChannel;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private closed = false;
  private everConnected = false;
  private curStatus: LanPeerStatus = 'connecting';
  // Candidates that arrive before the remote description (signaling rides an
  // UNORDERED gossip flood, so trickled ICE can beat the offer/answer). Capped.
  private pendingIce: RTCIceCandidateInit[] = [];
  // ── Phase 2A link-quality state (all per-peer, all reset with the peer) ──
  /** Consent counters read by the PREVIOUS poll — the delta source for the loss
   *  proxy (a data-only PC has no inbound-rtp, so there is no RTP loss to read). */
  private lastStun: LanStunCounters | null = null;
  /** Per-poll consent deltas inside the smoothing window; one lost consent check
   *  in a 3s sample would otherwise read as ~50% loss and strobe the dot. */
  private lossSamples: LanLossSample[] = [];
  /** Last successful getStats reduction — also the ONLY thing that can explain a
   *  'failed' link, whose PC is already gone by the time the event fires. */
  private lastSnap: LanStatsSnapshot | null = null;
  // OUR OWN send-drop rate over the current poll window (closed channel / HWM).
  private sendAttempts = 0;
  private sendDrops = 0;
  /** Phase 2B forwarding counters — kept OUT of dropPct on purpose (see forward()). */
  private relayAttempts = 0;
  private relayDrops = 0;
  /** A turn:/turns: entry exists in this room's iceServers — decides whether a
   *  failure reads "add a TURN server" or "TURN is configured and it still failed". */
  private turnConfigured: boolean;

  constructor(
    private id: string,
    private polite: boolean,       // selfId > memberId — deterministic glare split
    private a: LanAdapter,
    private onFrame: (frame: Buffer) => void,   // inbound datachannel msg → router
    private onFailed: (reason: LanIceFailReason) => void, // pc 'failed' → session latches the reason, reaps, maybe rebuilds
    private onStatus: (s: LanPeerStatus) => void, // connectionState → UI dot
    private now: () => number,
  ) {
    this.turnConfigured = hasTurn(a.iceServers as ReadonlyArray<{ urls?: string | string[] }>);
    this.pc = new RTCPeerConnection({ iceServers: a.iceServers });
    // must-fix #4: ONE out-of-band negotiated channel on both sides, unreliable +
    // unordered (games tolerate loss/reorder; retransmit-with-lag is worse).
    this.ch = this.pc.createDataChannel('lan', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.ch.binaryType = 'arraybuffer';
    this.ch.onmessage = (e) => {
      if (this.closed) return;
      const d = e.data;
      // arraybuffer per binaryType; tolerate a Blob/typed-array just in case.
      if (d instanceof ArrayBuffer) this.onFrame(Buffer.from(d));
      else if (ArrayBuffer.isView(d)) this.onFrame(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
    };

    // Creating the negotiated channel fires negotiationneeded on both sides; glare
    // is resolved by perfect negotiation (impolite wins, polite rolls back).
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.a.sendSignal(this.id, 'offer', this.pc.localDescription);
      } catch (e) { this.a.log('lan negotiation failed: ' + String(e)); }
      finally { this.makingOffer = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.a.sendSignal(this.id, 'ice', candidate); };
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const s = this.pc.connectionState;
      if (s === 'connected') { this.everConnected = true; this.setStatus('connected'); }
      else if (s === 'connecting' || s === 'new') this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
      else if (s === 'disconnected') this.setStatus('reconnecting');
      // Honest symmetric-NAT terminal state (plan §12.7): the reason is derived
      // from the LAST poll's candidate facts, because getStats on a failed PC is
      // already useless (and the session reaps this peer on the next line).
      else if (s === 'failed') { this.setStatus('failed'); this.onFailed(this.failReason()); }
      else if (s === 'closed') this.setStatus('failed');
    };
  }

  private setStatus(s: LanPeerStatus): void {
    if (this.curStatus === s) return;
    this.curStatus = s;
    this.onStatus(s);
  }

  status(): LanPeerStatus { return this.curStatus; }

  /** True only while the link is up right now (else it is (re)connecting). */
  linkConnected(): boolean { return this.pc.connectionState === 'connected'; }

  /** True once the link has connected at least once — a later drop reads as
   *  "reconnecting", while a first-time handshake shows no quality yet. */
  wasConnected(): boolean { return this.everConnected; }

  /** Data-channel readyState right now (diagnostics item C). */
  channelState(): 'connecting' | 'open' | 'closing' | 'closed' | 'unknown' {
    const s = this.ch?.readyState;
    return s === 'connecting' || s === 'open' || s === 'closing' || s === 'closed' ? s : 'unknown';
  }

  /** The last poll's reduction — read-only, so a diagnostics run costs nothing. */
  lastStats(): LanStatsSnapshot | null { return this.lastSnap; }

  /**
   * WHY this leg has no path, from the gathered ICE candidate types of the last
   * poll. 'unknown' when we never got a sample — an honest "don't know" beats a
   * guessed cause in a message that tells the user what to go fix.
   */
  failReason(): LanIceFailReason {
    const s = this.lastSnap;
    if (!s) return 'unknown';
    return explainIceFailure({
      localTypes: s.localTypes,
      remoteTypes: s.remoteTypes,
      anyPairSucceeded: s.anyPairSucceeded,
      turnConfigured: this.turnConfigured,
    });
  }

  /**
   * Sample OUR link to this peer — ONE getStats pass that feeds the quality dot,
   * the failure explanation and the diagnostics report alike (mirrors
   * MediaPeer.sampleQuality, room-voice.ts:496).
   *
   * Two deliberate divergences from voice: the selected CANDIDATE PAIR (not
   * inbound-rtp, which a data-only PC never emits) carries the RTT, and loss is
   * the ICE-consent delta smoothed over a window. Returns null — never a neutral
   * zero reading — when stats are unavailable, so an unmeasured link renders NO
   * dot instead of a flattering 'good'.
   */
  async sampleQuality(): Promise<LanPeerSample | null> {
    if (this.closed) return null;
    // Capture-and-zero the backpressure window UP FRONT, so every exit path (no
    // getStats, a rejecting/closing PC) still bounds it to one poll. Resetting
    // only on the success path let the counters accumulate across failed polls and
    // the next good sample divided drops by an arbitrarily long window.
    const attempts = this.sendAttempts, drops = this.sendDrops;
    this.sendAttempts = 0; this.sendDrops = 0;
    try {
      const pc = this.pc as unknown as { getStats?: () => Promise<unknown> };
      if (typeof pc.getStats !== 'function') return null; // stubbed/older PC — no dot, no crash
      const report = await pc.getStats();
      const rows: LanRawStat[] = [];
      // RTCStatsReport is Map-like; forEach is the one iteration API it guarantees.
      (report as { forEach?: (cb: (r: unknown) => void) => void })?.forEach?.((r) => {
        const row = r as LanRawStat | null;
        if (row && typeof row.type === 'string') rows.push(row);
      });
      const snap = reduceLanStats(rows);
      this.lastSnap = snap;

      // Consent loss: delta vs the previous read, accumulated over the window.
      const d = stunDelta(this.lastStun, snap.stun);
      this.lastStun = snap.stun;
      const now = this.now();
      if (d.sent > 0) this.lossSamples.push({ at: now, sent: d.sent, recv: d.recv });
      const w = windowedLoss(this.lossSamples, now);
      this.lossSamples = w.kept;

      // Our own backpressure drops over this window (explains game stutter that
      // no remote metric can see); captured+zeroed at entry.
      return { snap, loss: w.loss, dropPct: attempts > 0 ? drops / attempts : 0 };
    } catch {
      return null; // getStats rejects on a closing PC — no reading, no dot change
    }
  }

  /** Handle an inbound offer/answer/ice for this peer (perfect negotiation). */
  async onSignal(kind: LanSignalKind, data: unknown): Promise<void> {
    if (this.closed) return;
    try {
      if (kind === 'offer' || kind === 'answer') {
        const ready = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const collision = kind === 'offer' && !ready;
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return; // impolite peer keeps its own offer
        this.settingRemoteAnswer = kind === 'answer';
        await this.pc.setRemoteDescription(data as RTCSessionDescriptionInit); // polite: implicit rollback happens here
        this.settingRemoteAnswer = false;
        // Flush candidates buffered before this description landed.
        const pend = this.pendingIce; this.pendingIce = [];
        for (const c of pend) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
        if (kind === 'offer') {
          await this.pc.setLocalDescription();
          this.a.sendSignal(this.id, 'answer', this.pc.localDescription);
        }
      } else if (kind === 'ice') {
        if (!this.pc.remoteDescription) {
          if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(data as RTCIceCandidateInit);
          return; // buffer (capped) until we have the description
        }
        try { await this.pc.addIceCandidate(data as RTCIceCandidateInit); }
        catch (e) { if (!this.ignoreOffer) throw e; } // a dropped candidate after an ignored offer is expected
      }
    } catch (e) { this.a.log('lan signal error: ' + String(e)); }
  }

  /**
   * Send an IP frame over the data channel. Returns false (DROPPED, never queued)
   * when the channel is not open OR the send buffer is over the high-water mark —
   * plan §2 DROP policy.
   */
  send(frame: Buffer): boolean {
    // Every attempt/drop is counted for the per-poll dropPct — the one loss
    // signal that is genuinely OURS (no wire change, no peer cooperation).
    this.sendAttempts++;
    if (this.write(frame)) return true;
    this.sendDrops++;
    return false;
  }

  /**
   * Phase 2B — forward SOMEONE ELSE'S relayed frame over this leg. Identical
   * wire behaviour to send(), but the attempt/drop is counted SEPARATELY and is
   * deliberately NOT folded into the Phase-2A dropPct: dropPct must keep meaning
   * "OUR OWN game traffic was dropped". If relaying polluted it, being a good
   * citizen would make your own quality dot look bad and people would (rightly)
   * switch the feature off.
   */
  forward(msg: Buffer): boolean {
    this.relayAttempts++;
    if (this.write(msg)) return true;
    this.relayDrops++;
    return false;
  }

  /** Forwarding volume over this leg since the session started (diagnostics). */
  relayCounters(): { attempts: number; drops: number } {
    return { attempts: this.relayAttempts, drops: this.relayDrops };
  }

  /** The shared DROP-never-queue write. Returns false when the channel is not
   *  open OR the send buffer is over the high-water mark (plan §2 DROP policy). */
  private write(msg: Buffer): boolean {
    if (this.closed || this.ch.readyState !== 'open') return false;
    if (this.ch.bufferedAmount > LAN_SEND_HWM) return false;
    // A Node Buffer is a valid BufferSource at runtime; the cast bridges the
    // @types/node ArrayBufferLike ↔ DOM ArrayBuffer generic mismatch (no copy).
    try { this.ch.send(msg as unknown as ArrayBufferView<ArrayBuffer>); return true; }
    catch { return false; }
  }

  close(): void {
    this.closed = true;
    try { this.ch.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }
}

/**
 * The per-room virtual-LAN session (clone of the VoiceSession PATTERN, not its PC
 * objects). Owns the LanPeer mesh + the routing brain; delegates ALL admission /
 * vIP / anti-replay policy to the pure LanSessionCore.
 */
export class LanSession {
  private core: LanSessionCore;
  private peers = new Map<string, LanPeer>();
  private statuses = new Map<string, LanPeerStatus>();
  private active = false;
  private selfGen = 0;
  private lastAt = 0;
  // ── Phase 2A ──
  /** Last measured link per member; ABSENT means "no dot" (voice's rule). */
  private quality = new Map<string, LanLinkQuality>();
  /** LATCHED failure explanation per member. Latched rather than read live
   *  because onPeerFailed reaps and rebuilds instantly — the instantaneous status
   *  flips back to 'connecting' and the honest reason would flicker away. */
  private failReasons = new Map<string, LanIceFailReason>();
  /** Consecutive failures since the last successful connect (rebuild budget). */
  private failCounts = new Map<string, number>();
  /** Members whose rebuild budget is spent — the leg is terminally dead. THIS is
   *  the Phase 2B relay trigger: "direct is proven impossible", already sticky
   *  across the reap/rebuild churn. A merely connecting/reconnecting leg is never
   *  relayed, so the fast path stays untouched for every healthy pair. */
  private terminal = new Set<string>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  // ── Phase 2B: one-hop peer relay ──────────────────────────────────────────
  /** THIS install is willing to spend uplink forwarding for others (the
   *  `lanRelayEnabled` setting). Read LIVE on the forward path, so switching it
   *  off stops forwarding on the very next packet, not at the next advert. */
  private relayEnabled = true;
  /** Peers' signed reachability adverts (own monotonic floor + TTL inside). */
  private reach: LanReachTable;
  /** The session /16 — fixed for the session's life, so hoisted out of the
   *  per-frame path (Phase 1 recomputed it per frame; same value, less work). */
  private subnet: SubnetInfo;
  /**
   * Bumped by EVERY input that can change a relay decision (advert, leg status,
   * admit, evict, departure, willingness, teardown). The caches below are keyed
   * by it, so selection is never recomputed per frame — and they hold a memberId
   * ONLY. Caching a LanPeer / RTCDataChannel here would re-introduce the exact
   * stale-ref black hole this file's header warns about; the channel is still
   * resolved AT SEND TIME.
   */
  private relayEpoch = 0;
  private relayCacheEpoch = -1;
  /** Legs that are CONNECTED right now — our ground truth for both the advert we
   *  publish and the send-side intersection. */
  private legsCache = new Set<string>();
  /** target memberId → the relay to use (null = none). Epoch-scoped. */
  private relayRoutes = new Map<string, string | null>();
  /** Terminal members we CAN reach via a relay — unioned into RouteCtx.peerIds so
   *  broadcast discovery reaches them (they have no LanPeer to be listed by). */
  private relayEligibleCache: string[] = [];
  /** origin → last time we forwarded a frame for them (the visible indicator). */
  private relayServed = new Map<string, number>();
  /** Change-detection + cadence state for our own lan-reach advert. */
  private lastReachKey = '';
  private lastReachSentAt = 0;
  /** Reused encode buffer. RTCDataChannel.send() copies synchronously per spec,
   *  and each envelope is handed to send() before the next is encoded, so one
   *  buffer per session is safe and keeps the relayed path allocation-free. */
  private relayScratch: Buffer | null = null;

  constructor(private a: LanAdapter, private now: () => number = Date.now) {
    this.core = new LanSessionCore(a.sessionId, a.selfId, now);
    // Hand the table the live admission oracle so an over-cap prune evicts
    // synthetic (non-admitted) adverts before real members' — see pruneStore.
    this.reach = new LanReachTable(now, undefined, undefined, (id) => this.core.isAdmitted(id));
    this.subnet = sessionSubnet(a.sessionId);
    // Register the TUN-egress router once; gated on `active` inside the handler.
    this.a.onPacket((frame) => this.onTunFrame(frame));
  }

  isActive(): boolean { return this.active; }

  /** The session this instance tracks — used to reuse a passive joiner session
   *  (bootstrapped from gossip) when the user finally accepts. */
  sessionId(): string { return this.a.sessionId; }

  /** Strictly-increasing per-sender clock so every emitted lan-* `at` clears the
   *  receiver's per-type monotonic floor even when several are sent in one tick. */
  private nextAt(): number {
    const t = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = t;
    return t;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Host path: pin self as the session genesis, admit ourselves + the picks, then
   * announce and begin routing. Self-admit is deliberate: every member learns the
   * host's admission (member===hostId) via the flooded lan-admit, so the host's
   * vIP enters everyone's routing table and everyone may build a leg TO the host
   * — without it a joiner (who never receives an admit naming the host) could
   * neither route to nor peer with the host.
   */
  startAsHost(picks: string[]): void {
    if (this.active) return;
    this.active = true;
    const gAt = this.nextAt();
    this.core.pinGenesis(this.a.selfId, this.a.sessionId, gAt); // pin locally too
    this.a.genesis();                                            // signed lan-genesis (pins host for peers)
    this.hostAdmit(this.a.selfId);                               // self-admit (see doc above)
    for (const m of picks) if (m !== this.a.selfId) this.hostAdmit(m);
    this.announceSelf();
    this.maybeAdvertiseReach();                                  // publish willingness from tick 0
    this.armStatsPoll();                                         // host measures its own legs too
    this.a.onChange();
  }

  /** Joiner path: begin participating (called once a lan-admit naming us lands).
   *  Announce our presence and open legs to every currently-admitted member. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.announceSelf();
    for (const id of this.core.admittedIds()) if (id !== this.a.selfId) this.ensurePeer(id);
    this.maybeAdvertiseReach();
    this.armStatsPoll();
    this.a.onChange();
  }

  stop(): void {
    this.active = false;
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.statuses.clear();
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.quality.clear();
    this.failReasons.clear();
    this.failCounts.clear();
    this.terminal.clear();
    // Phase 2B: forget every relay ROUTE and everything we were forwarding, and
    // reset the advert change-detector so a restart re-publishes immediately.
    // The LanReachTable's per-member anti-replay FLOORS are deliberately kept —
    // dropping them would let a captured old advert replay into a fresh session.
    this.relayRoutes.clear();
    this.relayEligibleCache = [];
    this.relayServed.clear();
    this.legsCache.clear();
    this.lastReachKey = '';
    this.lastReachSentAt = 0;
    this.invalidateRelay();
    this.a.onChange();
  }

  /** Arm the getStats poll (mirrors VoiceSession's statsTimer, room-voice.ts:819).
   *  LAN has TWO entry points — start() and startAsHost() — and one exit, stop(),
   *  which suspend() delegates to, so the VPN kill-switch path is covered. */
  private armStatsPoll(): void {
    if (this.statsTimer) return;
    const t = setInterval(() => { void this.pollQuality(); }, LAN_QUALITY_POLL_MS);
    // In node (vitest) a Timeout keeps the event loop alive; the engine window
    // does not care, but a test that forgets stop() would hang the runner.
    (t as unknown as { unref?: () => void }).unref?.();
    this.statsTimer = t;
  }

  /**
   * Sample every leg and refresh the per-member quality entry (mirrors
   * VoiceSession.pollQuality, room-voice.ts:1365). Three rules copied verbatim
   * because they are what make the dot honest:
   *   • a peer that has never connected gets NO entry (no dot during handshake);
   *   • one that connected and dropped reads poor + reconnecting;
   *   • onChange() fires ONLY when something actually changed — this timer feeds
   *     pushState → IPC → React, so an unconditional push every 3s is a
   *     measurable regression in a window that also carries voice and files.
   * The LAN-specific addition: we sample NOT-yet-connected legs too, because
   * their gathered candidates are the only thing that can explain a later
   * 'failed' — they simply do not produce a quality entry.
   */
  private async pollQuality(): Promise<void> {
    if (!this.active) return;
    // Phase 2B rides this tick rather than arming a second timer: LAN_QUALITY_POLL_MS
    // IS the lan-reach minimum interval, so a rebuild storm that flips the leg set
    // several times a second still costs at most one advert per poll. The
    // invalidation also re-evaluates advert freshness (TTL) and leg liveness, so a
    // relay that silently went stale is dropped within one tick.
    this.invalidateRelay();
    this.maybeAdvertiseReach();
    // The "Relaying for N" badge DECAYS here. noteRelayServed pushes a change when
    // an origin first appears, but nothing else fires when one falls out of the
    // window — without this the badge would linger until some unrelated event
    // happened to rebuild the state.
    const servedBefore = this.relayServed.size;
    let changed = this.relayForList().length !== servedBefore;
    const seen = new Set<string>();
    for (const [id, p] of this.peers) {
      const s = await p.sampleQuality();
      if (!this.active) return;              // stopped while awaiting
      if (this.peers.get(id) !== p) continue; // reaped/rebuilt while awaiting
      let entry: LanLinkQuality | null = null;
      if (p.linkConnected()) {
        // A connected leg whose pair has produced no RTT and no consent response
        // yet is NOT 'good' — rtt 0 / loss 0 would classify as good. No dot yet.
        if (s && s.snap.havePair && isMeasured({ rttMs: s.snap.rttMs, responsesReceived: s.snap.stun.responsesReceived })) {
          entry = {
            level: classifyLanQuality({ rttMs: s.snap.rttMs, loss: s.loss }),
            rttMs: s.snap.rttMs,
            loss: s.loss,
            dropPct: s.dropPct,
            path: s.snap.path,
            local: s.snap.local,
            remote: s.snap.remote,
            reconnecting: false,
          };
        }
      } else if (p.wasConnected()) {
        entry = {
          level: 'poor', rttMs: 0, loss: 0, dropPct: s?.dropPct ?? 0,
          path: s?.snap.path ?? 'unknown',
          local: s?.snap.local ?? 'unknown',
          remote: s?.snap.remote ?? 'unknown',
          reconnecting: true,
        };
      }
      if (!entry) continue; // still doing the first handshake — no dot yet
      seen.add(id);
      if (linkQualityChanged(this.quality.get(id), entry)) changed = true;
      this.quality.set(id, entry);
    }
    for (const id of Array.from(this.quality.keys())) {
      if (!seen.has(id)) { this.quality.delete(id); changed = true; } // gone / torn down
    }
    if (changed) this.a.onChange();
  }

  /** VPN kill-switch / teardown — identical to stop (closes every leg). */
  suspend(): void { this.stop(); }

  private announceSelf(): void {
    this.a.announce(this.core.selfVip(), this.selfGen, this.nextAt());
  }

  // ── Host controls (invite / evict from the IPC layer) ───────────────────────

  /** Bridge for the engine's 'lanSignal' room-cmd (kind = invite|accept|evict,
   *  plus the Phase-2B relay-on|relay-off willingness toggle). */
  control(kind: string, memberId?: string): void {
    if (kind === 'invite' && memberId && this.a.isHost) this.hostAdmit(memberId);
    else if (kind === 'accept') this.start();
    else if (kind === 'evict' && memberId && this.a.isHost) this.hostEvict(memberId);
    else if (kind === 'relay-on') this.setRelayEnabled(true);
    else if (kind === 'relay-off') this.setRelayEnabled(false);
  }

  // ── Phase 2B: relay willingness, adverts and selection ─────────────────────

  /**
   * The `lanRelayEnabled` setting (engine pushes it on session start and on
   * change, like voiceSettings). Declining does exactly two things and needs no
   * other cooperation: our advert publishes `relay: false`, which removes us from
   * every peer's candidate set, and the live check on the forward path stops us
   * forwarding MID-SESSION rather than at the next advert.
   */
  setRelayEnabled(on: boolean): void {
    const v = on !== false;
    if (this.relayEnabled === v) return;
    this.relayEnabled = v;
    this.invalidateRelay();
    this.maybeAdvertiseReach();
    this.a.onChange();
  }

  /** Are we willing to forward for others right now? (UI + tests.) */
  isRelayEnabled(): boolean { return this.relayEnabled; }

  /**
   * A verified `lan-reach` advert from a peer (the engine calls this AFTER
   * verifySignedBy + clamp, exactly like onPeerState). The session gate is here;
   * the per-member MONOTONIC FLOOR — its own map, never shared with lan-state's —
   * lives inside LanReachTable.apply.
   *
   * Deliberately no ensurePeer/admission side effect: an advert is presence-class
   * information that grants NOTHING. A non-admitted member's advert is stored
   * (bounded) but relayCandidates filters it out, so it can never influence a
   * decision until the host actually admits them.
   */
  onPeerReach(m: { memberId: string; sessionId: string; at: number; relay: boolean; peers: readonly string[] }): void {
    if (m.sessionId !== this.a.sessionId) return; // a cross-session advert must never poison selection
    if (m.memberId === this.a.selfId) return;     // our own relayed echo
    if (!this.reach.apply({ memberId: m.memberId, at: m.at, relay: m.relay, peers: m.peers })) return;
    this.invalidateRelay();
    this.a.onChange();
  }

  /**
   * Emit our own reachability advert if it is due. ONE emitter, three rules:
   *   • on CHANGE of (sorted connected legs, willingness) — nothing else moves it;
   *   • never more often than LAN_REACH_MIN_INTERVAL_MS (a change inside the floor
   *     is coalesced — the next quality-poll tick re-tries and emits it once);
   *   • an unconditional refresh every LAN_REACH_REFRESH_MS, which is well under
   *     the receiver's TTL, so a live member never expires out of a candidate set.
   * ⇒ ~1 advert / 30 s / member at steady state. It can never become a storm.
   */
  private maybeAdvertiseReach(force = false): void {
    if (!this.active) return;
    this.refreshRelayCaches();
    // Canonical wire form is MANDATORY: the receiver's clamp normalises, so any
    // other representation yields bytes the verifier cannot reproduce.
    const peers = normalizeReachList([...this.legsCache]);
    const key = (this.relayEnabled ? '1|' : '0|') + peers.join(',');
    const t = this.now();
    const changed = key !== this.lastReachKey;
    const due = t - this.lastReachSentAt >= LAN_REACH_REFRESH_MS;
    if (!force && !changed && !due) return;
    if (!force && !due && t - this.lastReachSentAt < LAN_REACH_MIN_INTERVAL_MS) return; // coalesce
    this.lastReachKey = key;
    this.lastReachSentAt = t;
    this.a.reach(peers, this.relayEnabled, this.nextAt());
  }

  /** Every input that can change a relay decision calls this. Cheap (an integer);
   *  the actual recomputation is lazy, in refreshRelayCaches. */
  private invalidateRelay(): void { this.relayEpoch++; }

  /** Rebuild the epoch-scoped caches: our connected legs, the per-target relay
   *  choice, and which terminal members are relay-reachable at all. */
  private refreshRelayCaches(): void {
    if (this.relayCacheEpoch === this.relayEpoch) return;
    this.relayCacheEpoch = this.relayEpoch;
    this.relayRoutes.clear();
    const legs = new Set<string>();
    for (const [id, p] of this.peers) if (p.linkConnected()) legs.add(id);
    this.legsCache = legs;
    this.relayEligibleCache = this.active ? relayEligible(this.relayView(), this.relayTargets()) : [];
  }

  /** The immutable snapshot the pure selector reads. */
  private relayView(): LanRelayView {
    return this.reach.view(this.a.selfId, this.core.view().admitted, this.legsCache);
  }

  /** Members eligible to be RELAYED TO: admitted, terminally failed (so direct is
   *  proven impossible) and with no LanPeer of their own left. */
  private relayTargets(): string[] {
    const out: string[] = [];
    for (const id of this.terminal) {
      if (id === this.a.selfId || this.peers.has(id)) continue;
      if (!this.core.isAdmitted(id)) continue;
      out.push(id);
    }
    return out;
  }

  /** The relay to use for `target` right now, or null. Epoch-cached; holds a
   *  memberId ONLY — the LanPeer is resolved at send time, never stored. */
  private relayRoute(target: string): string | null {
    this.refreshRelayCaches();
    const hit = this.relayRoutes.get(target);
    if (hit !== undefined) return hit;
    const via = selectRelay(this.relayView(), target);
    this.relayRoutes.set(target, via);
    return via;
  }

  /** The relay currently carrying `id`'s traffic for us, for the UI. Null unless
   *  the leg is genuinely reaped + terminal — a peer that is merely rebuilding is
   *  NEVER shown as relayed, because it is not being relayed. */
  private relayVia(id: string): string | null {
    if (!this.active || this.peers.has(id) || !this.terminal.has(id)) return null;
    return this.relayRoute(id);
  }

  /** Note that we just forwarded for `origin` (feeds the visible indicator). */
  private noteRelayServed(origin: string): void {
    const known = this.relayServed.has(origin);
    this.relayServed.set(origin, this.now());
    while (this.relayServed.size > LAN_MAX_RELAY_SERVED) {
      const first = this.relayServed.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.relayServed.delete(first);
    }
    if (!known) this.a.onChange(); // the badge appeared — tell the UI once, not per packet
  }

  /** Origins we forwarded for inside the visibility window (expired ones pruned). */
  private relayForList(): string[] {
    const t = this.now();
    for (const [id, at] of this.relayServed) {
      if (t - at > LAN_RELAY_SERVED_WINDOW_MS) this.relayServed.delete(id);
    }
    return [...this.relayServed.keys()].sort();
  }

  private hostAdmit(memberId: string): void {
    const at = this.nextAt();
    if (!this.core.applyAdmit(this.a.selfId, memberId, at, this.a.sessionId)) return;
    this.a.admit(memberId, at);
    if (this.active && memberId !== this.a.selfId) this.ensurePeer(memberId);
    this.a.onChange();
  }

  private hostEvict(memberId: string): void {
    const at = this.nextAt();
    if (!this.core.applyEvict(this.a.selfId, memberId, at, this.a.sessionId)) return;
    this.a.evict(memberId, at);
    this.dropPeer(memberId);
    this.forgetFailure(memberId);
    this.forgetRelay(memberId); // same as onEvict: stop relaying for/through them now
    this.a.onChange();
  }

  // ── Inbound gossip feeders (engine calls these AFTER verifySignedBy) ─────────

  /** A verified lan-genesis: pin the session host (first-writer-wins per sessionId). */
  onGenesis(hostId: string, sessionId: string, at: number): void {
    if (this.core.pinGenesis(hostId, sessionId, at)) this.a.onChange();
  }

  /** A verified lan-admit (sessionId threaded from the signed message so the core
   *  can reject a cross-session replay — must-fix #1). A self-admit only RECORDS
   *  the grant (surfaced as selfAdmitted → the UI offers Accept); it deliberately
   *  does NOT auto-start, because starting announces presence and builds legs, and
   *  the joiner must first bring up its elevated helper via an explicit Accept.
   *  A non-self admit opens a leg only if we're already participating. */
  onAdmit(by: string, target: string, at: number, sessionId: string): void {
    if (!this.core.applyAdmit(by, target, at, sessionId)) return;
    if (target !== this.a.selfId && this.active) this.ensurePeer(target);
    this.invalidateRelay(); // a newly admitted member may be a candidate (or a target)
    this.a.onChange();
  }

  /** A verified lan-evict (sessionId threaded — must-fix #1 DoS variant). If it
   *  names US, tear down; otherwise drop that leg. */
  onEvict(by: string, target: string, at: number, sessionId: string): void {
    if (!this.core.applyEvict(by, target, at, sessionId)) return;
    if (target === this.a.selfId) this.stop();
    else { this.dropPeer(target); this.forgetFailure(target); this.forgetRelay(target); }
    this.a.onChange();
  }

  /** A verified lan-state presence + vIP claim (already vIP-checked by the engine;
   *  applyState re-verifies + admission-gates for the routing table). An admitted
   *  member announcing presence → build the mesh leg. On a self collision loss,
   *  bump gen and re-announce so the table converges identically at every peer. */
  onPeerState(c: LanStateClaim): void {
    if (!this.core.applyState(c)) return;
    const bump = this.core.bumpGenOnCollision();
    if (bump) {
      // Lost the vIP arbitration → re-IP the physical adapter to the new vip
      // (must-fix #6) THEN re-announce, so peers and our own TUN converge on the
      // fresh address. A brief egress/ingress blip during the helper's re-IP is
      // acceptable for a rare (~0.1%/8-peer) collision; the game retries through it.
      this.selfGen = bump.gen;
      this.a.reip(bump.vip, bump.gen);
      if (this.active) this.announceSelf();
    }
    if (this.active && this.core.isAdmitted(c.memberId)) this.ensurePeer(c.memberId);
    // Host: a peer announcing presence may have joined AFTER (or missed) our
    // one-shot genesis/admit flood — re-flood the durable authority so it can pin
    // us + open its leg, regardless of the initial gossip order.
    if (this.a.isHost) this.rebroadcastAuthority();
    this.a.onChange();
  }

  /**
   * A verified lan-signal for us. THE ADMISSION GATE (must-fix #1): drop signaling
   * from any member the host has not admitted BEFORE ensurePeer — a
   * rostered-but-unadmitted keyholder must be physically unable to force a LanPeer.
   * This is the deliberate divergence from voice's self-service onSignal.
   */
  onSignal(from: string, kind: LanSignalKind, data: unknown): void {
    if (!this.active || from === this.a.selfId) return;
    if (!this.core.isAdmitted(from)) return; // GATE — no LanPeer for the unadmitted
    void this.ensurePeer(from)?.onSignal(kind, data);
  }

  // ── Membership churn ────────────────────────────────────────────────────────

  /** A member left the ROOM (applyLocalRekey / prune): release their vIP/route and
   *  close their leg. Anti-replay floors are KEPT inside the core (replay defence). */
  onMemberGone(memberId: string): void {
    this.core.onMemberGone(memberId);
    this.dropPeer(memberId);
    this.forgetFailure(memberId); // genuinely gone — clear the latches, not just the leg
    this.forgetRelay(memberId);
    this.a.onChange();
  }

  /**
   * Phase 2B — a member is EVICTED or has left the room. Stop relaying for them
   * and stop relaying THROUGH them, immediately.
   *
   * Belt and braces on purpose. The authoritative stop is structural: the core
   * has already removed them from `admitted` (and from the vIP table, which is
   * rebuilt from admitted claims only), so planRelayForward / acceptRelayedInbound
   * refuse them on the very NEXT packet with no cache to go stale. This just drops
   * the now-meaningless bookkeeping — their advert (so they leave every candidate
   * set at once rather than at TTL), the "we are relaying for them" entry, and the
   * route cache. Their anti-replay FLOOR is deliberately kept inside the table.
   */
  private forgetRelay(memberId: string): void {
    this.reach.forget(memberId);
    this.relayServed.delete(memberId);
    this.invalidateRelay();
  }

  /** Drop the per-member failure latches (reason / rebuild count / terminal flag).
   *  ONLY for a member who genuinely leaves the session — never from dropPeer,
   *  which onPeerFailed calls and which must PRESERVE the latch across a rebuild.
   *  Without this the maps grow for the session's life and a re-invited member
   *  stays permanently marked as terminally failed. */
  private forgetFailure(memberId: string): void {
    this.failReasons.delete(memberId);
    this.failCounts.delete(memberId);
    this.terminal.delete(memberId);
  }

  /** Host-only: re-flood the DURABLE authority (lan-genesis + every live lan-admit)
   *  WITHOUT re-announcing our own presence — so a late/reordered joiner re-pins the
   *  host and re-applies admits (must-fix #2). Kept separate from announceSelf so
   *  re-flooding on a peer's presence can't ping-pong lan-state back and forth. */
  rebroadcastAuthority(): void {
    if (!this.active || !this.a.isHost) return;
    this.a.genesis();
    this.remintAdmits();
  }

  /** Re-broadcast on a new member's hello: our transient presence + (host) the
   *  durable authority, so a peer that reconnected on a fresh wire re-converges. */
  reannounce(): void {
    if (!this.active) return;
    this.announceSelf();
    // lan-reach is TRANSIENT (topic-bound), so it survives a rekey by being
    // RE-ANNOUNCED, never by being re-signed. force: a rekey/hello must republish
    // even when nothing about our legs changed, or the new peer has no adverts.
    this.maybeAdvertiseReach(true);
    this.rebroadcastAuthority();
  }

  /** Rekey re-mint (must-fix #2): the host re-emits lan-admit for every live admit
   *  under the rotated topic so admitted players aren't silently dropped. A no-op
   *  for a non-host / inactive session. */
  remintAdmits(): void {
    if (!this.active || !this.a.isHost) return;
    for (const id of this.core.admittedIds()) this.a.admit(id, this.nextAt());
  }

  // ── The routing brain ───────────────────────────────────────────────────────

  /**
   * TUN-egress: a raw frame the local stack emitted (registered via adapter.onPacket).
   * planRoute (pure) classifies + src-spoof-checks, then we resolve each target
   * memberId → LanPeer AT SEND TIME (never cache — a reaped/stale ref black-holes).
   */
  private onTunFrame(frame: Buffer): void {
    if (!this.active) return;
    this.refreshRelayCaches();
    const ctx: RouteCtx = {
      view: this.core.view(),
      subnetBroadcast: this.subnet.broadcast,
      selfId: this.a.selfId,
      // Phase 2B widens this from "live peers" to "DELIVERABLE members". A peer
      // whose leg latched terminal was reaped out of `peers`, so with the Phase-1
      // list it would receive relayed UNICAST (planRoute's unicast arm consults
      // vipOwners, not peerIds) but would be silently excluded from every
      // BROADCAST fan-out — i.e. ping would work and LAN game discovery never
      // would, which is the whole point of the feature. planRoute itself is
      // unchanged; only the input set is wider.
      peerIds: this.relayEligibleCache.length === 0
        ? [...this.peers.keys()]
        : [...new Set([...this.peers.keys(), ...this.relayEligibleCache])],
    };
    const plan = planRoute(frame, ctx);
    if (plan.kind === 'drop' || plan.targets.length === 0) return;
    for (const memberId of plan.targets) {
      const p = this.peers.get(memberId); // resolve now, never a cached channel
      if (p) { p.send(frame); continue; } // DIRECT — the Phase 1/2A hot path, unchanged
      this.sendViaRelay(memberId, frame);
    }
  }

  /**
   * Phase 2B egress fallback: wrap one frame for `target` and hand it to the
   * chosen relay. Note the ORIGINATOR replicates — a broadcast produces one
   * envelope per relayed destination, each naming its destination explicitly, so
   * the relay does strict 1-in-1-out and can never fan out (no amplification).
   * That replication cost lands on OUR uplink, which is where it already lands
   * for direct broadcast.
   */
  private sendViaRelay(target: string, frame: Buffer): void {
    const via = this.relayRoute(target);
    if (!via) return;
    const p = this.peers.get(via); // resolved AT SEND TIME — never a cached channel
    if (!p) return;
    if (!this.relayScratch) this.relayScratch = Buffer.allocUnsafe(MAX_RELAY_FRAME);
    const env = encodeRelayFrame(this.a.selfId, target, frame, this.relayScratch);
    if (!env) return;
    p.send(env); // OUR traffic → counted in OUR dropPct, correctly
  }

  /**
   * Mesh-ingress: a message from `from` over their data channel.
   *
   * DISPATCH IS TOTAL ON THE FIRST BYTE. A relay envelope starts with 0x52, whose
   * high nibble (5) can never be an IP version; EVERYTHING else takes the Phase
   * 1/2A direct path completely unchanged — per-peer token bucket, acceptInbound
   * src-check, inject. A pre-2B peer receiving an envelope feeds it to parseIpv4,
   * gets null and drops it harmlessly, so there is no flag day.
   */
  private onPeerFrame(from: string, frame: Buffer): void {
    if (!this.active) return;
    if (isRelayFrame(frame)) {
      // WIRE-LEVEL budget FIRST, keyed by the sending channel — the only key an
      // attacker cannot choose. Without this, anything whose first byte is 0x52
      // reached the decoder having cleared NO budget at all: the relay-in /
      // relay-out buckets key off the envelope's ORIGINATOR (sender-chosen) and are
      // charged only after a successful decode, so pure garbage was unbounded.
      if (!this.core.allowPacket(from, frame.length, 'relay-wire')) return;
      this.onRelayFrame(from, frame);
      return;
    }
    if (!this.core.allowPacket(from, frame.length)) return;   // per-peer rate limit
    if (!acceptInbound(frame, from, this.core.view())) return; // src-spoof / self-origin drop
    this.a.sendPacket(frame);
  }

  /**
   * A relay envelope arrived. Exactly two fates, decided by the target named in
   * the envelope — there is no third branch, and in particular NO path that turns
   * a delivered frame back into a forwardable one:
   *
   *   • target === us → DELIVER. acceptRelayedInbound independently re-derives the
   *     originator from OUR host-signed vIP table and requires it to equal the
   *     envelope's claim, requires that originator to be admitted and not the
   *     relay, and requires the relay to be in OUR OWN candidate set for that
   *     originator. Charged to a 'relay-in' bucket keyed by the ORIGINATOR.
   *   • otherwise → FORWARD, at most once. planRelayForward's one-hop gate is
   *     `from === envelope.origin`; a frame that already travelled once arrives
   *     from the relay, not the origin, so it can never satisfy it. Charged to a
   *     'relay-out' bucket keyed by the originator AND to the session-wide
   *     forwarding ceiling.
   *
   * Neither path can touch the DIRECT per-peer bucket, and neither can be reached
   * by a bare IPv4 frame.
   */
  private onRelayFrame(from: string, msg: Buffer): void {
    const env = decodeRelayFrame(msg);
    if (!env) return; // hostile / truncated / wrong version — never throws
    this.refreshRelayCaches();
    const core = this.core.view();
    const view = this.reach.view(this.a.selfId, core.admitted, this.legsCache);

    if (env.target === this.a.selfId) {
      const d = acceptRelayedInbound(msg, from, {
        view, core, subnet: this.subnet,
        // INVARIANT 3, receiver half. Relaying is a FALLBACK for pairs with no
        // direct path, so accepting relayed traffic attributed to a member we hold
        // a working leg to is never legitimate — and allowing it hands any admitted
        // member the ability to inject frames bearing another member's source IP
        // (the relay's own reachability advert is a self-claim and proves nothing).
        // Gate on OUR OWN ground truth: no direct leg to that originator.
        strictDirect: true,
        // Receiver-side relayed budget, keyed by the ORIGINATOR and entirely
        // separate from the proven direct bucket (a relayed flood must not be
        // able to eat the budget that protects normal gameplay).
        // Per-originator AND a session-wide receive ceiling — mirroring the forward
        // path. The per-origin bucket alone bounds ONE pair; without the aggregate,
        // several originators relaying at us still add up without limit.
        budget: (origin, bytes) =>
          this.core.allowPacket(origin, bytes, 'relay-in')
          && this.core.allowPacket(LAN_RELAY_TOTAL_MEMBER, bytes, 'relay-in'),
      });
      if (d.kind === 'accept') this.a.sendPacket(d.inner);
      return;
    }

    const f = planRelayForward(msg, from, {
      view, core, subnet: this.subnet,
      willing: this.relayEnabled, // read LIVE — switching off stops the next packet
      budget: (origin, _target, bytes) =>
        // Per-originator FIRST, the session-wide ceiling SECOND. Order matters: a
        // pair that has already blown its own budget must never get to spend a
        // token from the shared uplink cap on the way to being refused.
        this.core.allowPacket(origin, bytes, 'relay-out')
        && this.core.allowPacket(LAN_RELAY_TOTAL_MEMBER, bytes, 'relay-out'),
    });
    if (f.kind !== 'forward') return;
    const p = this.peers.get(f.to); // resolved AT SEND TIME
    if (!p) return;
    if (p.forward(f.frame)) this.noteRelayServed(f.origin);
  }

  // ── The admission gate + peer reap (NOT a copy of voice's open onPeerState) ──

  /** Build/return the LanPeer for memberId. REFUSES (undefined) if the member is
   *  not host-admitted or the mesh cap is reached. Roster membership is
   *  necessary-but-NOT-sufficient — only a host-signed admit populates admittedSet. */
  private ensurePeer(memberId: string): LanPeer | undefined {
    if (memberId === this.a.selfId) return undefined;
    const existing = this.peers.get(memberId);
    if (existing) return existing;
    if (!this.core.isAdmitted(memberId)) return undefined; // must-fix #1
    if (this.peers.size >= MAX_LAN_PEERS) { this.a.log('lan peer cap reached — not connecting ' + memberId.slice(0, 8)); return undefined; }
    const polite = this.a.selfId > memberId; // deterministic glare split
    const p = new LanPeer(
      memberId, polite, this.a,
      (frame) => this.onPeerFrame(memberId, frame),
      (reason) => this.onPeerFailed(memberId, reason),
      (s) => this.setStatus(memberId, s),
      this.now,
    );
    this.peers.set(memberId, p);
    this.terminal.delete(memberId); // a fresh attempt is, by definition, not terminal
    this.invalidateRelay();         // a live leg reappeared → direct beats any relay
    this.setStatus(memberId, p.status());
    return p;
  }

  private dropPeer(memberId: string): void {
    const p = this.peers.get(memberId);
    if (p) { p.close(); this.peers.delete(memberId); }
    this.statuses.delete(memberId);
    this.quality.delete(memberId); // measurements die with the PC they came from
    // Phase 2B: the leg set changed, so both our own advert and every route that
    // pointed THROUGH this member must be recomputed.
    this.invalidateRelay();
  }

  /**
   * A LanPeer reached 'failed'. Latch WHY (the rebuilt peer starts with no stats
   * and could only report 'unknown'), then reap and rebuild — but only while the
   * rebuild budget lasts. Once it is spent the leg stays 'failed' so the panel can
   * say "no direct path — configure a TURN server" instead of showing an eternal,
   * dishonest 'connecting' (plan §12.7, Phase 2A item B).
   */
  private onPeerFailed(memberId: string, reason: LanIceFailReason): void {
    if (!this.active) return;
    // Never let a later factless 'unknown' erase a real explanation.
    if (reason !== 'unknown' || !this.failReasons.has(memberId)) this.failReasons.set(memberId, reason);
    const n = (this.failCounts.get(memberId) ?? 0) + 1;
    this.failCounts.set(memberId, n);
    this.dropPeer(memberId);
    if (!this.core.isAdmitted(memberId)) { this.a.onChange(); return; }
    if (n >= LAN_MAX_PEER_REBUILDS) {
      this.terminal.add(memberId);
      // Phase 2B: THIS is the moment the relay fallback becomes eligible for this
      // member. dropPeer above already bumped the epoch, but latching terminal is
      // a second, independent input to the decision — do not rely on ordering.
      this.invalidateRelay();
      this.statuses.set(memberId, 'failed'); // dropPeer cleared it — restate it as terminal
      this.a.log(`lan leg to ${memberId.slice(0, 8)} terminally failed after ${n} attempts (${this.failReasons.get(memberId)})`);
      this.a.onChange();
      return;
    }
    this.ensurePeer(memberId);
  }

  private setStatus(memberId: string, s: LanPeerStatus): void {
    let changed = false;
    if (s === 'connected') {
      // A working link retires the latched failure story (budget, reason, terminal).
      if (this.failCounts.delete(memberId)) changed = true;
      if (this.failReasons.delete(memberId)) changed = true;
      if (this.terminal.delete(memberId)) changed = true;
    }
    if (this.statuses.get(memberId) !== s) { this.statuses.set(memberId, s); changed = true; }
    if (changed) {
      // Phase 2B: a leg coming up or going down changes BOTH what we advertise
      // and every route that ran through this member. Clearing `terminal` above
      // is also what makes a relayed pair revert to direct the instant the direct
      // leg reconnects — relayVia() is false the moment the latch is gone.
      this.invalidateRelay();
      this.maybeAdvertiseReach(); // floor-coalesced; the poll tick catches the rest
      this.a.onChange();
    }
  }

  // ── State projection for the UI ─────────────────────────────────────────────

  buildState(): RoomLanState {
    const sub = this.subnet;
    const relayFor = this.active ? this.relayForList() : [];
    const hostId = this.core.hostId();
    const selfVipNum = this.core.selfVip();
    const participants: RoomLanParticipant[] = [];
    if (this.active) {
      participants.push({
        memberId: this.a.selfId,
        vip: vipToString(selfVipNum),
        admitted: this.core.isAdmitted(this.a.selfId),
        status: 'connected',
      });
    }
    for (const id of this.core.admittedIds()) {
      if (id === this.a.selfId) continue;
      const v = this.core.memberVip(id);
      // Optional-spread discipline (voice getState, room-voice.ts:1396): an
      // unmeasured leg carries NO quality key at all, so the UI renders no dot
      // rather than a default one. Self is never measured (it has no LanPeer).
      const q = this.quality.get(id);
      const fail = this.failReasons.get(id);
      // Phase 2B. `status` and `failReason` deliberately stay HONEST about the
      // DIRECT leg (it really is terminally failed); the UI keys off relayVia to
      // render "connected through <name>" instead of the red no-path block. See
      // the RoomLanParticipant doc — widening LanPeerStatus would silently
      // reshape every exhaustive map over it for a purely cosmetic gain.
      // A relayed peer carries NO quality of its own either: it has no LanPeer,
      // so `quality` is already absent here, and getStats could only ever have
      // measured our leg to the RELAY — projecting that as the pair's quality is
      // exactly the flattering dishonesty Phase 2A was built to avoid.
      const via = this.relayVia(id);
      const advert = this.reach.get(id);
      participants.push({
        memberId: id,
        vip: v !== undefined ? vipToString(v) : '',
        admitted: true,
        status: this.statuses.get(id) ?? 'connecting',
        ...(via ? { relayVia: via } : {}),
        ...(advert ? { relayWilling: advert.relay } : {}),
        ...(q ? {
          quality: q.level,
          rttMs: Math.round(q.rttMs),
          lossPct: lossToPct(q.loss),
          dropPct: lossToPct(q.dropPct),
          candidate: q.local,
          remoteCandidate: q.remote,
          path: q.path,
          ...(q.reconnecting ? { reconnecting: true } : {}),
        } : {}),
        ...(fail ? { failReason: fail } : {}),
        ...(this.terminal.has(id) ? { terminal: true } : {}),
      });
    }
    return {
      available: true,
      active: this.active,
      sessionId: this.a.sessionId,
      selfVip: this.active ? vipToString(selfVipNum) : undefined,
      subnet: `${vipToString(sub.base)}/${sub.prefix}`,
      hostId: hostId ?? undefined,
      isHost: this.a.isHost,
      // Whether the host has admitted US — the join gate. True on a passive
      // (not-yet-active) session means "invited, ready to Accept".
      selfAdmitted: this.core.isAdmitted(this.a.selfId),
      // A room's iceServers are fixed when the room starts, so this also tells the
      // UI whether "add a TURN server" is still an available fix for a failed leg
      // (and that the session must be restarted after configuring one).
      turnConfigured: hasTurn(this.a.iceServers as ReadonlyArray<{ urls?: string | string[] }>),
      // Phase 2B. `relayEnabled` is the willingness toggle; `relayFor` is the
      // VISIBLE cost of saying yes — the distinct originators we actually
      // forwarded for in the last ~10s. Damped rather than instantaneous so the
      // badge does not strobe while two ends converge on the same relay.
      relayEnabled: this.relayEnabled,
      ...(relayFor.length ? { relayFor } : {}),
      participants,
    };
  }

  /** Alias — some engine wiring calls getState() (mirrors room.voice.getState()). */
  getState(): RoomLanState { return this.buildState(); }

  /**
   * Per-peer facts for the connectivity report (Phase 2A item C), read from the
   * LAST poll — a diagnostics run must never trigger a second getStats pass, and
   * must never be the only thing that measures a link (the 3s poll owns that).
   * Members whose leg has been reaped are still listed, with whatever the latch
   * remembers, because "the peer is admitted and has NO channel" is a finding.
   */
  peerDiagnostics(): LanDiagPeer[] {
    const out: LanDiagPeer[] = [];
    for (const id of this.core.admittedIds()) {
      if (id === this.a.selfId) continue;
      const v = this.core.memberVip(id);
      const p = this.peers.get(id);
      const snap = p?.lastStats() ?? null;
      const q = this.quality.get(id);
      // "Admitted, no direct channel, but reachable via C" is a finding worth
      // reporting — and it is what stops the diagnostics reading a working
      // relayed pair as an unreachable one.
      const via = this.relayVia(id);
      out.push({
        memberId: id,
        ...(v !== undefined ? { vip: vipToString(v) } : {}),
        status: this.statuses.get(id) ?? 'connecting',
        channelState: p?.channelState() ?? 'unknown',
        ...(q ? { rttMs: q.rttMs, loss: q.loss } : {}),
        ...(snap ? { localCandidate: snap.local, remoteCandidate: snap.remote } : {}),
        ...(this.terminal.has(id) ? { terminal: true } : {}),
        ...(via ? { relayVia: via } : {}),
      });
    }
    return out;
  }
}
