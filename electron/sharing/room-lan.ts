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
 * ALL policy/state (genesis pinning, admittedSet, the verified vIP→member table,
 * per-type anti-replay floors, per-peer token buckets) lives in the pure,
 * node-testable shared/lan-session-core.ts; route planning lives in the pure
 * shared/lan-router.ts. This file is only the RTCPeerConnection wiring around
 * them. RTCPeerConnection is referenced ONLY inside class bodies (never at module
 * import time) so node vitest can import the file and drive it with a fake adapter.
 */

import { LanSessionCore, MAX_LAN_PEERS, MAX_PENDING_ICE } from '../../shared/lan-session-core';
import type { LanStateClaim } from '../../shared/lan-session-core';
import { planRoute, acceptInbound } from '../../shared/lan-router';
import type { RouteCtx } from '../../shared/lan-router';
import { sessionSubnet, vipToString } from '../../shared/lan-ip';
import type { RoomLanState, RoomLanParticipant, LanPeerStatus } from '../../shared/lan-types';

export type LanSignalKind = 'offer' | 'answer' | 'ice';

/** DROP backpressure threshold (plan §2): once the channel's send buffer exceeds
 *  this, further frames are dropped rather than queued — a game tunnel wants drop,
 *  queueing degrades unreliable into reliable-with-lag. Precedent: remote-cast
 *  streamTo HIGH_WATER. */
const LAN_SEND_HWM = 256 * 1024;

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

  constructor(
    private id: string,
    private polite: boolean,       // selfId > memberId — deterministic glare split
    private a: LanAdapter,
    private onFrame: (frame: Buffer) => void,   // inbound datachannel msg → router
    private onFailed: () => void,               // pc 'failed' → session reaps + rebuilds
    private onStatus: (s: LanPeerStatus) => void, // connectionState → UI dot
    private now: () => number,
  ) {
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
      else if (s === 'failed') { this.setStatus('failed'); this.onFailed(); } // honest symmetric-NAT terminal state (plan §12.7)
      else if (s === 'closed') this.setStatus('failed');
    };
  }

  private setStatus(s: LanPeerStatus): void {
    if (this.curStatus === s) return;
    this.curStatus = s;
    this.onStatus(s);
  }

  status(): LanPeerStatus { return this.curStatus; }

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
    if (this.closed || this.ch.readyState !== 'open') return false;
    if (this.ch.bufferedAmount > LAN_SEND_HWM) return false;
    // A Node Buffer is a valid BufferSource at runtime; the cast bridges the
    // @types/node ArrayBufferLike ↔ DOM ArrayBuffer generic mismatch (no copy).
    try { this.ch.send(frame as unknown as ArrayBufferView<ArrayBuffer>); return true; }
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

  constructor(private a: LanAdapter, private now: () => number = Date.now) {
    this.core = new LanSessionCore(a.sessionId, a.selfId, now);
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
    this.a.onChange();
  }

  /** Joiner path: begin participating (called once a lan-admit naming us lands).
   *  Announce our presence and open legs to every currently-admitted member. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.announceSelf();
    for (const id of this.core.admittedIds()) if (id !== this.a.selfId) this.ensurePeer(id);
    this.a.onChange();
  }

  stop(): void {
    this.active = false;
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.statuses.clear();
    this.a.onChange();
  }

  /** VPN kill-switch / teardown — identical to stop (closes every leg). */
  suspend(): void { this.stop(); }

  private announceSelf(): void {
    this.a.announce(this.core.selfVip(), this.selfGen, this.nextAt());
  }

  // ── Host controls (invite / evict from the IPC layer) ───────────────────────

  /** Bridge for the engine's 'lanSignal' room-cmd (kind = invite|accept|evict). */
  control(kind: string, memberId?: string): void {
    if (kind === 'invite' && memberId && this.a.isHost) this.hostAdmit(memberId);
    else if (kind === 'accept') this.start();
    else if (kind === 'evict' && memberId && this.a.isHost) this.hostEvict(memberId);
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
    this.a.onChange();
  }

  /** A verified lan-evict (sessionId threaded — must-fix #1 DoS variant). If it
   *  names US, tear down; otherwise drop that leg. */
  onEvict(by: string, target: string, at: number, sessionId: string): void {
    if (!this.core.applyEvict(by, target, at, sessionId)) return;
    if (target === this.a.selfId) this.stop();
    else this.dropPeer(target);
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
    this.a.onChange();
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
    const ctx: RouteCtx = {
      view: this.core.view(),
      subnetBroadcast: sessionSubnet(this.a.sessionId).broadcast,
      selfId: this.a.selfId,
      peerIds: [...this.peers.keys()],
    };
    const plan = planRoute(frame, ctx);
    if (plan.kind === 'drop' || plan.targets.length === 0) return;
    for (const memberId of plan.targets) {
      this.peers.get(memberId)?.send(frame); // resolve now, never a cached channel
    }
  }

  /**
   * Mesh-ingress: a frame from `from` over their data channel. Per-peer token
   * bucket first (anti-flood), then acceptInbound src-check (the frame's src must
   * be that member's assigned vIP), then inject into the local TUN via the helper.
   */
  private onPeerFrame(from: string, frame: Buffer): void {
    if (!this.active) return;
    if (!this.core.allowPacket(from, frame.length)) return;   // per-peer rate limit
    if (!acceptInbound(frame, from, this.core.view())) return; // src-spoof / self-origin drop
    this.a.sendPacket(frame);
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
      () => this.onPeerFailed(memberId),
      (s) => this.setStatus(memberId, s),
      this.now,
    );
    this.peers.set(memberId, p);
    this.setStatus(memberId, p.status());
    return p;
  }

  private dropPeer(memberId: string): void {
    const p = this.peers.get(memberId);
    if (p) { p.close(); this.peers.delete(memberId); }
    this.statuses.delete(memberId);
  }

  /** A LanPeer reached 'failed' (e.g. torn down our side while the peer kept
   *  theirs). Reap and, if still admitted, re-create a clean pair (voice pattern). */
  private onPeerFailed(memberId: string): void {
    if (!this.active) return;
    this.dropPeer(memberId);
    if (this.core.isAdmitted(memberId)) this.ensurePeer(memberId);
  }

  private setStatus(memberId: string, s: LanPeerStatus): void {
    if (this.statuses.get(memberId) === s) return;
    this.statuses.set(memberId, s);
    this.a.onChange();
  }

  // ── State projection for the UI ─────────────────────────────────────────────

  buildState(): RoomLanState {
    const sub = sessionSubnet(this.a.sessionId);
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
      participants.push({
        memberId: id,
        vip: v !== undefined ? vipToString(v) : '',
        admitted: true,
        status: this.statuses.get(id) ?? 'connecting',
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
      participants,
    };
  }

  /** Alias — some engine wiring calls getState() (mirrors room.voice.getState()). */
  getState(): RoomLanState { return this.buildState(); }
}
