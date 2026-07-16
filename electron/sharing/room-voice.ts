/**
 * Voice session for a room — serverless full-mesh audio.
 *
 * Runs in the hidden room-engine renderer (which is a Chromium context, so it has
 * native getUserMedia + RTCPeerConnection). Each voice participant holds a
 * dedicated media RTCPeerConnection to every OTHER participant; join/leave/mute are
 * gossiped as presence and the media is negotiated with the "perfect negotiation"
 * pattern so simultaneous joins don't deadlock. This module is deliberately
 * auth-agnostic: it emits/consumes plain signaling and presence, and the engine
 * wraps them in the room's ENCRYPTED, Ed25519-SIGNED gossip (so a member can't
 * spoof another's voice signaling). Media itself is DTLS-SRTP between peers — no
 * server, no relay hears it (E2E by construction).
 *
 * Extensibility: MediaPeer is track-agnostic. v1 attaches one audio track; a
 * future screenshare/video adds a video track + a view surface with no change to
 * the presence/negotiation machinery.
 */

export type SignalKind = 'offer' | 'answer' | 'ice';

/** How the mic decides when to transmit: always open, gated by voice activity
 *  (auto-mute on silence), or only while a push-to-talk key is held. */
export type VoiceInputMode = 'always' | 'vad' | 'ptt';

/** What the engine provides to a VoiceSession (gossip + identity + config). */
export interface VoiceAdapter {
  selfId: string;
  iceServers: RTCIceServer[];
  /** Send a signaling blob to ONE member (engine signs + gossips it, targeted). */
  sendSignal(to: string, kind: SignalKind, data: unknown): void;
  /** Announce our voice presence/mute (engine signs + broadcasts to the room). `at`
   *  is a monotonic wall-clock stamp bound into the signature so peers reject replays. */
  announce(inVoice: boolean, muted: boolean, at: number): void;
  /** Voice state changed — engine should rebuild + push room state to the UI. */
  onChange(): void;
  log(msg: string): void;
}

export interface VoiceParticipant {
  memberId: string;
  muted: boolean;
  speaking: boolean;
}

export interface VoiceState {
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
  transmitting: boolean;   // the mic is LIVE right now (open + not gated) — drives the mic-live indicator
  inputMode: VoiceInputMode;
  participants: VoiceParticipant[]; // includes self when inVoice
}

// Mesh cap: each participant holds a PC to every other, so this bounds fan-out
// AND caps how many RTCPeerConnections a hostile member can force us to allocate
// (they can mint unlimited valid identities). ~8 others is the friend-scale ceiling.
const MAX_VOICE_PEERS = 8;
const MAX_PENDING_ICE = 64;  // per-peer ICE buffer cap (real ICE is a few dozen) — bounds a flood-before-offer

// Speaking detection tuning (0-255 average magnitude; empirical for voice).
const VAD_THRESHOLD = 14;
const VAD_HANGOVER_MS = 250;   // keep "speaking" this long after it drops (anti-flicker)
const VAD_POLL_MS = 100;       // setInterval, not rAF — rAF is throttled in a hidden window

/** Voice-activity detector: watches a stream's level and reports speaking on/off. */
class Vad {
  private ctx: AudioContext | null = null;
  private timer: any = null;
  private speaking = false;
  private lastLoud = 0;

  constructor(stream: MediaStream, private onSpeaking: (s: boolean) => void, private now: () => number) {
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      this.timer = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length;
        const t = this.now();
        if (avg > VAD_THRESHOLD) this.lastLoud = t;
        const s = t - this.lastLoud < VAD_HANGOVER_MS;
        if (s !== this.speaking) { this.speaking = s; this.onSpeaking(s); }
      }, VAD_POLL_MS);
    } catch { /* Web Audio unavailable — speaking indicator just stays off */ }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    if (this.speaking) { this.speaking = false; this.onSpeaking(false); }
  }
}

/** One media connection to one other voice participant (perfect negotiation). */
class MediaPeer {
  private pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private audioEl: HTMLAudioElement | null = null;
  private vad: Vad | null = null;
  private closed = false;
  private pendingIce: RTCIceCandidateInit[] = []; // candidates that arrived before the remote description (relay reorder)
  volume = 1;

  constructor(
    private id: string,
    private polite: boolean,
    private a: VoiceAdapter,
    localStream: MediaStream,
    private onSpeaking: (s: boolean) => void,
    private now: () => number,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: a.iceServers });
    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);
    // Adding our track fires negotiationneeded → we offer. Both sides do this on
    // connect; glare is resolved below (impolite wins, polite rolls back).
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.a.sendSignal(this.id, 'offer', this.pc.localDescription);
      } catch (e) { this.a.log('voice negotiation failed: ' + String(e)); }
      finally { this.makingOffer = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.a.sendSignal(this.id, 'ice', candidate); };
    this.pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (!this.audioEl) { this.audioEl = new Audio(); this.audioEl.autoplay = true; }
      this.audioEl.srcObject = stream;
      this.audioEl.volume = this.volume;
      this.audioEl.play().catch(() => { /* autoplay policy is permissive here; ignore */ });
      // VAD on the REMOTE stream drives their speaking indicator (no gossip needed).
      this.vad?.stop();
      this.vad = new Vad(stream, (s) => { if (!this.closed) this.onSpeaking(s); }, this.now);
    };
  }

  async onSignal(kind: SignalKind, data: any): Promise<void> {
    if (this.closed) return;
    try {
      if (kind === 'offer' || kind === 'answer') {
        const ready = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const collision = kind === 'offer' && !ready;
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return; // impolite peer keeps its own offer
        this.settingRemoteAnswer = kind === 'answer';
        await this.pc.setRemoteDescription(data); // polite peer: implicit rollback happens here
        this.settingRemoteAnswer = false;
        // Flush candidates that arrived before this description (signaling rides an
        // UNORDERED relay flood, so trickled ICE can beat the offer/answer).
        const pend = this.pendingIce; this.pendingIce = [];
        for (const c of pend) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
        if (kind === 'offer') {
          await this.pc.setLocalDescription();
          this.a.sendSignal(this.id, 'answer', this.pc.localDescription);
        }
      } else if (kind === 'ice') {
        if (!this.pc.remoteDescription) { if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(data); return; } // buffer (capped) until we have the description
        try { await this.pc.addIceCandidate(data); }
        catch (e) { if (!this.ignoreOffer) throw e; } // a dropped candidate after an ignored offer is expected
      }
    } catch (e) { this.a.log('voice signal error: ' + String(e)); }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audioEl) this.audioEl.volume = this.volume;
  }

  /** Deafen: mute output without renegotiating (keeps AEC reference alive-ish). */
  setDeafened(d: boolean): void {
    if (this.audioEl) this.audioEl.muted = d;
  }

  close(): void {
    this.closed = true;
    this.vad?.stop(); this.vad = null;
    try { this.pc.close(); } catch { /* ignore */ }
    if (this.audioEl) { try { this.audioEl.srcObject = null; } catch { /* ignore */ } this.audioEl = null; }
  }
}

export class VoiceSession {
  private active = false;
  private joining = false; // getUserMedia in flight (re-entrancy guard)
  private muted = false;
  private deafened = false;
  private mutedBeforeDeafen = false; // restore this exact mute state on un-deafen
  private inputMode: VoiceInputMode = 'always';
  private pttActive = false;         // is the push-to-talk key held right now
  private vadOpen = false;           // local VAD currently detecting speech
  private localStream: MediaStream | null = null; // capture track (sent to peers, gated)
  private vadStream: MediaStream | null = null;   // an always-open CLONE, so gating the sent track never starves the VAD
  private localVad: Vad | null = null;
  private localSpeaking = false;
  private peers = new Map<string, MediaPeer>();               // memberId → media connection
  private roster = new Map<string, { muted: boolean }>();     // OTHER members currently in voice
  private speaking = new Map<string, boolean>();              // memberId → speaking (remote)
  private volumes = new Map<string, number>();                // memberId → 0..1
  private lastStateAt = new Map<string, number>();            // memberId → last accepted voice-state timestamp (anti-replay)
  private announceAt = 0;                                      // strictly-monotonic stamp for OUR announcements
  private pendingOffers = new Map<string, unknown>();          // authenticated offer that arrived before its sender's presence (relay reorder), applied on roster (capped)

  constructor(private a: VoiceAdapter, private now: () => number = () => Date.now()) {}

  isActive(): boolean { return this.active; }

  async join(): Promise<void> {
    if (this.active || this.joining) return; // guard the in-flight getUserMedia too (no double stream)
    // navigator.mediaDevices is undefined outside a secure context — surface a
    // clear error instead of a cryptic "cannot read getUserMedia of undefined".
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone unavailable (the room engine is not a secure context).');
    }
    this.joining = true;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } finally { this.joining = false; }
    this.active = true;
    this.muted = false;
    this.pttActive = false;
    this.vadOpen = false;
    this.applyTransmit();
    // Run VAD on an always-open CLONE of the mic track: gating the SENT track via
    // enabled=false makes it emit silence, which would starve a VAD reading that
    // same track ('vad' mode would latch shut). The clone shares the source but
    // keeps its own enabled=true, so voice-activity gating can re-open.
    const clone = this.localStream.getAudioTracks()[0]?.clone();
    this.vadStream = clone ? new MediaStream([clone]) : null;
    this.localVad = this.vadStream
      ? new Vad(this.vadStream, (s) => this.onVad(s), this.now)
      : null;
    this.a.announce(true, this.muted, this.nextAt());
    for (const id of this.roster.keys()) this.ensurePeer(id); // connect to everyone already here
    this.a.onChange();
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.localVad?.stop(); this.localVad = null;
    this.vadStream?.getTracks().forEach((t) => t.stop());
    this.vadStream = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.localSpeaking = false;
    this.vadOpen = false;
    this.pttActive = false;
    this.speaking.clear();
    this.pendingOffers.clear();
    this.a.announce(false, false, this.nextAt());
    this.a.onChange();
  }

  setMuted(muted: boolean): void {
    if (!this.active || this.muted === muted) return;
    this.muted = muted;
    this.applyTransmit();
    this.a.announce(true, this.muted, this.nextAt());
    this.a.onChange();
  }

  setDeafened(deafened: boolean): void {
    if (!this.active || this.deafened === deafened) return;
    this.deafened = deafened;
    for (const p of this.peers.values()) p.setDeafened(deafened);
    if (deafened) {
      // Deafening also mutes your mic (Discord convention); remember the prior mute
      // state so un-deafening restores it exactly (not force-unmute).
      this.mutedBeforeDeafen = this.muted;
      if (!this.muted) { this.muted = true; this.applyTransmit(); }
    } else {
      if (this.muted !== this.mutedBeforeDeafen) { this.muted = this.mutedBeforeDeafen; this.applyTransmit(); }
    }
    this.a.announce(true, this.muted, this.nextAt());
    this.a.onChange();
  }

  setInputMode(mode: VoiceInputMode): void {
    if (mode !== 'always' && mode !== 'vad' && mode !== 'ptt') return;
    this.inputMode = mode;
    this.applyTransmit();
    this.a.onChange();
  }

  /** Push-to-talk key pressed/released (only meaningful in 'ptt' mode). */
  setPtt(active: boolean): void {
    if (this.pttActive === active) return;
    this.pttActive = active;
    if (this.inputMode === 'ptt') { this.applyTransmit(); this.a.onChange(); }
  }

  setVolume(memberId: string, v: number): void {
    this.volumes.set(memberId, v);
    this.peers.get(memberId)?.setVolume(v);
  }

  private onVad(open: boolean): void {
    this.vadOpen = open;
    if (this.inputMode === 'vad') this.applyTransmit(); // gate the sent track on speech
    const speaking = this.transmitting() && open;
    if (speaking !== this.localSpeaking) { this.localSpeaking = speaking; this.a.onChange(); }
  }

  /** Are we sending audio right now (open + not gated by mode)? */
  private transmitting(): boolean {
    if (!this.active || this.muted) return false;
    if (this.inputMode === 'ptt') return this.pttActive;
    if (this.inputMode === 'vad') return this.vadOpen;
    return true; // 'always'
  }

  /** Strictly-increasing stamp for our own announcements, so two changes in the
   *  same millisecond still each beat the receiver's last-accepted `at`. */
  private nextAt(): number {
    this.announceAt = Math.max(this.now(), this.announceAt + 1);
    return this.announceAt;
  }

  private applyTransmit(): void {
    const on = this.transmitting();
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = on; });
    if (!on && this.localSpeaking) this.localSpeaking = false;
  }

  /** Presence gossip from a peer (they joined/left voice or changed mute). `at` is
   *  a monotonic wall-clock stamp bound into the signature; we accept only strictly
   *  newer state per member, so a replayed (older) voice-state can't resurrect a
   *  departed member or flip their displayed mute. */
  onPeerState(memberId: string, inVoice: boolean, muted: boolean, at: number): void {
    if (memberId === this.a.selfId) return;
    if (!Number.isFinite(at) || at <= (this.lastStateAt.get(memberId) ?? 0)) return; // stale/replayed — drop
    this.lastStateAt.set(memberId, at);
    const had = this.roster.has(memberId);
    if (inVoice) {
      // Cap: don't let unlimited (possibly fabricated) identities grow the roster.
      if (!had && this.roster.size >= MAX_VOICE_PEERS) { this.a.log('voice roster full — ignoring ' + memberId.slice(0, 8)); return; }
      this.roster.set(memberId, { muted });
    } else {
      this.roster.delete(memberId); this.speaking.delete(memberId);
    }
    if (this.active) {
      if (inVoice) this.ensurePeer(memberId);
      else this.dropPeer(memberId);
    }
    if (had !== inVoice || this.active) this.a.onChange();
  }

  /** A signaling blob for us from `from` (already auth-verified by the engine).
   *  We ONLY talk media to a member who announced voice presence (is in the roster)
   *  or whom we already have a peer with — otherwise a member could mint identities
   *  and force us to spin up (and never reclaim) an RTCPeerConnection per fake id,
   *  or become an invisible caller not shown in the roster. */
  onSignal(from: string, kind: SignalKind, data: unknown): void {
    if (!this.active || from === this.a.selfId) return;
    const peer = this.peers.get(from);
    if (peer) { void peer.onSignal(kind, data as any); return; }
    if (this.roster.has(from)) { this.ensurePeer(from)?.onSignal(kind, data as any); return; }
    // Not yet rostered — their presence announce hasn't arrived (the flood is
    // unordered, so a relay-only offer can beat it). Buffer ONE offer per unknown
    // member (bounded), applied when their voice-state lands (ensurePeer), so a
    // reordered offer isn't lost → no glare deadlock. Non-offers are meaningless
    // without a peer and are dropped.
    if (kind === 'offer' && this.pendingOffers.size < MAX_VOICE_PEERS) this.pendingOffers.set(from, data);
  }

  /** A member left the ROOM entirely — drop them from voice too. */
  onMemberGone(memberId: string): void {
    this.lastStateAt.delete(memberId);
    this.pendingOffers.delete(memberId);
    if (!this.roster.has(memberId) && !this.peers.has(memberId)) return;
    this.roster.delete(memberId);
    this.speaking.delete(memberId);
    this.dropPeer(memberId);
    this.a.onChange();
  }

  /** Re-broadcast our presence (call when a NEW member appears, so a late joiner
   *  learns we're already in voice — presence is only gossiped on change). */
  reannounce(): void {
    if (this.active) this.a.announce(true, this.muted, this.nextAt());
  }

  /** VPN kill-switch / room teardown: fully stop voice (releases the mic). */
  suspend(): void { this.leave(); }

  private ensurePeer(memberId: string): MediaPeer | undefined {
    let p = this.peers.get(memberId);
    if (!p && this.localStream) {
      if (this.peers.size >= MAX_VOICE_PEERS) { this.a.log('voice peer cap reached — not connecting ' + memberId.slice(0, 8)); return undefined; }
      // Deterministic polite/impolite split by id so exactly one side wins glare.
      const polite = this.a.selfId > memberId;
      p = new MediaPeer(memberId, polite, this.a, this.localStream, (s) => this.setSpeaking(memberId, s), this.now);
      const v = this.volumes.get(memberId);
      if (v !== undefined) p.setVolume(v);
      if (this.deafened) p.setDeafened(true);
      this.peers.set(memberId, p);
      // Apply an offer that raced ahead of this member's presence announce.
      const pending = this.pendingOffers.get(memberId);
      if (pending !== undefined) { this.pendingOffers.delete(memberId); void p.onSignal('offer', pending as any); }
    }
    return p;
  }

  private dropPeer(memberId: string): void {
    const p = this.peers.get(memberId);
    if (p) { p.close(); this.peers.delete(memberId); }
  }

  private setSpeaking(memberId: string, s: boolean): void {
    if ((this.speaking.get(memberId) ?? false) === s) return;
    this.speaking.set(memberId, s);
    this.a.onChange();
  }

  getState(): VoiceState {
    const participants: VoiceParticipant[] = [];
    if (this.active) participants.push({ memberId: this.a.selfId, muted: this.muted, speaking: this.localSpeaking && !this.muted });
    for (const [id, st] of this.roster) {
      participants.push({ memberId: id, muted: st.muted, speaking: !!this.speaking.get(id) && !st.muted });
    }
    return { inVoice: this.active, muted: this.muted, deafened: this.deafened, transmitting: this.transmitting(), inputMode: this.inputMode, participants };
  }
}
