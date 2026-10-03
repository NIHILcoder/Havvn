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

import type { VoiceSettings, NoiseSuppressionMode } from '../../shared/types';
import { RNNOISE_WASM_BASE64 } from './voice/rnnoise-wasm';
import { RNNOISE_WORKLET_SOURCE } from './voice/rnnoise-worklet';
import { ScreenAec } from './voice/screen-aec';

import { VoiceLinkRecovery, type VoiceLinkState } from '../../shared/room-voice-recovery';
import { acceptVoiceStamp, ROOM_VOICE_PEERS, ROOM_VOICE_ROSTER, voiceMeshMembers } from '../../shared/room-voice-policy';

export type SignalKind = 'offer' | 'answer' | 'ice';

// Screen-share echo-canceller FIR length (samples @ the AEC context rate, ~48k).
// Must cover the loopback delay (audio-element buffering + OS render + capture) —
// tens of ms; ~64ms here. Time-domain NLMS, so heavier taps cost more CPU.
const AEC_TAPS = 3072;

/** How the mic decides when to transmit: always open, gated by voice activity
 *  (auto-mute on silence), or only while a push-to-talk key is held. */
export type VoiceInputMode = 'always' | 'vad' | 'ptt';

export function defaultVoiceSettings(): VoiceSettings {
  return {
    inputDeviceId: null,
    outputDeviceId: null,
    inputGain: 1,
    masterVolume: 1,
    vadThreshold: 14,
    echoCancellation: true,
    noiseSuppressionMode: 'enhanced',
    autoGainControl: true,
  };
}

function sanitizeNsMode(v: unknown): NoiseSuppressionMode {
  return v === 'off' || v === 'standard' || v === 'enhanced' ? v : 'enhanced';
}

/** Clamp untrusted (renderer-supplied) settings into safe bounds. */
export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  const d = defaultVoiceSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  };
  const dev = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= 256 ? v : null);
  return {
    inputDeviceId: dev(r.inputDeviceId),
    outputDeviceId: dev(r.outputDeviceId),
    inputGain: num(r.inputGain, 0, 2, d.inputGain),
    masterVolume: num(r.masterVolume, 0, 1, d.masterVolume),
    vadThreshold: num(r.vadThreshold, 1, 128, d.vadThreshold),
    echoCancellation: r.echoCancellation !== false,
    noiseSuppressionMode: sanitizeNsMode(r.noiseSuppressionMode),
    autoGainControl: r.autoGainControl !== false,
  };
}

/** Should the browser's built-in noise suppression be requested? Only in 'standard'
 *  mode — 'enhanced' uses RNNoise (double-processing hurts) and 'off' uses neither. */
function browserNs(s: VoiceSettings): boolean {
  return s.noiseSuppressionMode === 'standard';
}

/** The knobs that require a fresh getUserMedia (vs live-adjustable ones). The NS mode
 *  is here because it changes the browser noiseSuppression constraint AND the graph
 *  topology (RNNoise node in/out), both reconciled through the recapture path. */
function captureKey(s: VoiceSettings): string {
  return JSON.stringify([s.inputDeviceId, s.echoCancellation, browserNs(s), s.autoGainControl, s.noiseSuppressionMode]);
}

/** Loopback (engine → visible renderer) signaling kinds for the screen-watch
 *  forwarder. 'end' tells the renderer the stream is gone (close the overlay). */
export type LoopbackKind = 'offer' | 'ice' | 'end';

/** What the engine provides to a VoiceSession (gossip + identity + config). */
export interface VoiceAdapter {
  selfId: string;
  iceServers: RTCIceServer[];
  /** Send a signaling blob to ONE member (engine signs + gossips it, targeted). */
  sendSignal(to: string, kind: SignalKind, data: unknown): void;
  /** Announce our voice presence/mute (engine signs + broadcasts to the room). `at`
   *  is a monotonic wall-clock stamp bound into the signature so peers reject replays. */
  announce(inVoice: boolean, muted: boolean, at: number, deafened?: boolean): void;
  /** Announce our screenshare presence (signed + broadcast; own monotonic `at`). */
  announceShare(sharing: boolean, streamId: string, at: number): void;
  /** Loopback signaling for the screen-watch overlay: engine → main → renderer. */
  sendLoopback(memberId: string, kind: LoopbackKind, data?: unknown): void;
  /** Voice state changed — engine should rebuild + push room state to the UI. */
  onChange(): void;
  /** Surface a transient, user-facing warning (e.g. a mid-call mic fallback). */
  warn(msg: string): void;
  log(msg: string): void;
}

export type VoiceQuality = 'good' | 'fair' | 'poor';

export interface VoiceParticipant {
  memberId: string;
  muted: boolean;
  /** Authenticated by voice-state-v2; legacy peers carry a cosmetic field. */
  deafened?: boolean;
  speaking: boolean;
  sharing: boolean;        // this member is sharing their screen
  quality?: VoiceQuality;  // OUR link quality to this peer (getStats RTT + loss)
  reconnecting?: boolean;  // the link dropped and is re-establishing (ICE)
  connection?: VoiceLinkState;
  reconnectAttempts?: number;
  waitingForSlot?: boolean;
}

export interface VoiceState {
  micUnavailable?: boolean;
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
  transmitting: boolean;   // the mic is LIVE right now (open + not gated) — drives the mic-live indicator
  inputMode: VoiceInputMode;
  sharing: boolean;        // WE are sharing our screen
  participants: VoiceParticipant[]; // includes self when inVoice
}

// Mesh cap: each participant holds a PC to every other, so this bounds fan-out
// AND caps how many RTCPeerConnections a hostile member can force us to allocate
// (they can mint unlimited valid identities). ~8 others is the friend-scale ceiling.
const MAX_VOICE_PEERS = ROOM_VOICE_PEERS;
const MAX_PENDING_ICE = 64;  // per-peer ICE buffer cap (real ICE is a few dozen) — bounds a flood-before-offer
// Anti-replay floors survive departures and fail closed at the shared identity cap.

// Screenshare quality caps. The mesh leg is real upstream bandwidth (per watching
// viewer); the loopback leg is host-local, so its cap only bounds encoder CPU.
const SHARE_MESH_MAX_BITRATE = 2_500_000;
const SHARE_LOOPBACK_MAX_BITRATE = 10_000_000;
const SHARE_MAX_FRAMERATE = 15;

/** Best-effort sender bitrate/framerate cap (screen video legs). */
async function applyShareCaps(sender: RTCRtpSender, maxBitrate: number, failed?: () => void): Promise<void> {
  try {
    const p = sender.getParameters();                       // reuse — carries transactionId
    (p as any).degradationPreference = 'maintain-resolution'; // pairs with contentHint 'detail' (text stays sharp)
    if (!p.encodings?.length) p.encodings = [{} as RTCRtpEncodingParameters];
    p.encodings[0].maxBitrate = maxBitrate;
    (p.encodings[0] as any).maxFramerate = SHARE_MAX_FRAMERATE;
    await sender.setParameters(p);
  } catch { failed?.(); /* encoder caps are best-effort, surface mesh failures */ }
}

// Voice-link quality poll cadence + thresholds (RTT ms / loss fraction). A poll
// reads each peer's getStats and downgrades the tile dot; friendly for a mesh of
// ≤8, cheap enough at 3s.
const QUALITY_POLL_MS = 3000;
const RTT_FAIR_MS = 200, RTT_POOR_MS = 400;
const LOSS_FAIR = 0.03, LOSS_POOR = 0.08;

// Speaking detection tuning (0-255 average magnitude; empirical for voice).
const VAD_THRESHOLD = 14;
const VAD_HANGOVER_MS = 250;   // keep "speaking" this long after it drops (anti-flicker)
const VAD_POLL_MS = 100;       // setInterval, not rAF — rAF is throttled in a hidden window

/** Voice-activity detector: watches a stream's level and reports speaking on/off.
 *  `onLevel` (optional) receives the raw 0-255 average each poll — the settings
 *  UI's mic-test meter rides the same analyser. */
class Vad {
  private ctx: AudioContext | null = null;
  private timer: any = null;
  private speaking = false;
  private lastLoud = 0;
  private threshold: number;

  constructor(
    stream: MediaStream,
    private onSpeaking: (s: boolean) => void,
    private now: () => number,
    threshold: number = VAD_THRESHOLD,
    private onLevel?: (avg: number) => void,
  ) {
    this.threshold = threshold;
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
        this.onLevel?.(avg);
        const t = this.now();
        if (avg > this.threshold) this.lastLoud = t;
        const s = t - this.lastLoud < VAD_HANGOVER_MS;
        if (s !== this.speaking) { this.speaking = s; this.onSpeaking(s); }
      }, VAD_POLL_MS);
    } catch { /* Web Audio unavailable — speaking indicator just stays off */ }
  }

  /** Live sensitivity adjustment (the settings slider) — no restart needed. */
  setThreshold(t: number): void {
    if (Number.isFinite(t)) this.threshold = Math.max(1, Math.min(128, t));
  }

  resume(): void { try { void this.ctx?.resume().catch(() => {}); } catch { /* unavailable context */ } }

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
  readonly recovery: VoiceLinkRecovery;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private audioEl: HTMLAudioElement | null = null;
  private vad: Vad | null = null;
  private closed = false;
  private pendingIce: RTCIceCandidateInit[] = []; // candidates that arrived before the remote description (relay reorder)
  private sinkId = '';  // desired output device ('' = system default); applied when audioEl exists
  private deafened = false;                        // WE are deafened (mutes every peer's output)
  private locallyMuted = false;                    // this member is locally muted on THIS install (output cut, PC kept)
  private shareTransceiver: RTCRtpTransceiver | null = null; // OUR outgoing screen VIDEO transceiver (sendonly)
  private shareAudioTransceiver: RTCRtpTransceiver | null = null; // OUR outgoing screen AUDIO transceiver (sendonly)
  private watching = false;                        // we want THEIR screen video (recv gating)
  private micStreamId = '';                        // this peer's MIC audio stream id (the FIRST audio stream)
  private shareStreamId = '';                      // this peer's screen MediaStream id (from voice-share) — routes screen audio
  private shareAudioEl: HTMLAudioElement | null = null; // plays THEIR shared screen audio (separate from mic; deafen mutes it too)
  volume = 1;           // EFFECTIVE volume (master × per-user) — the session computes it

  constructor(
    private id: string,
    private polite: boolean,
    private a: VoiceAdapter,
    localStream: MediaStream,
    private onSpeaking: (s: boolean) => void,
    private onRemoteShare: (track: MediaStreamTrack | null, stream: MediaStream | null) => void,
    private onConnectionChange: () => void,
    private onMicStream: (stream: MediaStream | null) => void,
    private now: () => number,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: a.iceServers });
    this.recovery = new VoiceLinkRecovery(() => this.pc.restartIce(), this.onConnectionChange, this.now, () => this.pc.connectionState, () => Math.floor(Math.random() * 250));
    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);
    // Adding our track fires negotiationneeded → we offer. Both sides do this on
    // connect; glare is resolved below (impolite wins, polite rolls back).
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (!this.closed) this.a.sendSignal(this.id, 'offer', this.pc.localDescription);
      } catch (e) { this.a.log('voice negotiation failed: ' + String(e)); }
      finally { this.makingOffer = false; }
    };
    // Keep the existing media connection and restart ICE with a bounded budget.
    // Short disconnects get a grace period; leave() cancels all recovery timers.
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected' && this.shareTransceiver) this.setScreenBitrate(this.screenBitrate / 1000);
      if (s === 'connected') this.everConnected = true; // arms the "reconnecting" state (vs a first-time connect)
      if (!this.closed) this.recovery.update(s);
    };
    this.pc.oniceconnectionstatechange = () => { if (!this.closed) this.recovery.update(this.pc.connectionState); };
    this.pc.onicecandidate = ({ candidate }) => { if (!this.closed && candidate) this.a.sendSignal(this.id, 'ice', candidate); };
    this.pc.ontrack = ({ track, streams }) => {
      if (this.closed) return;
      const stream = streams[0];
      if (!stream) return;
      if (track.kind === 'video') {
        // Screen path: no Audio element, no VAD. Hand the track up — the session
        // attaches it to a loopback forwarder if (or when) the user watches.
        track.onended = () => { if (!this.closed) this.onRemoteShare(null, null); };
        this.onRemoteShare(track, stream);
        return;
      }
      // Audio: either the peer's MIC or their SCREEN audio (M20). Both are `audio`
      // tracks on this PC, so key on the stream (msid): the screen shares the
      // announced share streamId; the mic is the FIRST audio stream (initial
      // negotiation, before any share). If the share announce hasn't landed yet,
      // any SECOND audio stream is the screen (the mic always arrives first).
      const isScreen = this.shareStreamId
        ? stream.id === this.shareStreamId
        : (!!this.micStreamId && stream.id !== this.micStreamId);
      if (isScreen) { this.playShareAudio(stream); return; }
      if (!this.micStreamId) this.micStreamId = stream.id;
      if (!this.audioEl) { this.audioEl = new Audio(); this.audioEl.autoplay = true; }
      this.audioEl.srcObject = stream;
      this.audioEl.volume = this.volume;
      this.applyOutputMute(); // honor a deafen / local-mute set before the track arrived
      this.applySink();
      this.audioEl.play().catch(() => { /* autoplay policy is permissive here; ignore */ });
      // VAD on the REMOTE stream drives their speaking indicator (no gossip needed).
      this.vad?.stop();
      this.vad = new Vad(stream, (s) => { if (!this.closed) this.onSpeaking(s); }, this.now);
      this.onMicStream(stream); // let the session use it as an AEC reference if WE share audio
    };
  }

  /** Play a peer's shared SCREEN audio (v1: no per-peer volume — deafen/local-mute
   *  silence it like the mic; not gated by watch, so shared audio is heard even
   *  without opening the screen view). */
  private playShareAudio(stream: MediaStream): void {
    if (this.closed) return;
    if (!this.shareAudioEl) { this.shareAudioEl = new Audio(); this.shareAudioEl.autoplay = true; }
    this.shareAudioEl.srcObject = stream;
    this.shareAudioEl.muted = this.deafened || this.locallyMuted;
    const el = this.shareAudioEl as any;
    if (el.setSinkId) el.setSinkId(this.sinkId).catch(() => { /* device gone — default */ });
    this.shareAudioEl.play().catch(() => { /* permissive here */ });
  }

  /** The peer's screen MediaStream id (from the signed voice-share) — lets ontrack
   *  route their screen audio. Re-evaluated so a track that arrived BEFORE the
   *  announce (routed as mic) moves to the screen element. */
  setShareStreamId(id: string): void {
    this.shareStreamId = id || '';
    // A screen-audio track may have landed before the announce and been mis-routed
    // onto the mic element. If the mic element now holds the share stream, move it.
    if (id && this.audioEl && (this.audioEl.srcObject as MediaStream | null)?.id === id) {
      const s = this.audioEl.srcObject as MediaStream;
      try { this.audioEl.srcObject = null; } catch { /* ignore */ }
      this.vad?.stop(); this.vad = null;
      this.micStreamId = '';
      this.onMicStream(null);
      this.playShareAudio(s);
    }
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
        try { await this.pc.setRemoteDescription(data); // polite peer: implicit rollback happens here
        } finally { this.settingRemoteAnswer = false; }
        if (this.closed) return;
        this.settingRemoteAnswer = false;
        // Flush candidates that arrived before this description (signaling rides an
        // UNORDERED relay flood, so trickled ICE can beat the offer/answer).
        const pend = this.pendingIce; this.pendingIce = [];
        for (const c of pend) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
        if (kind === 'offer') {
          // Answer remote video m-lines per our watch state BEFORE the implicit
          // answer: 'inactive' unless watching, so a share we don't view costs the
          // sharer no bandwidth. Idempotent — re-applied on every offer, which also
          // self-heals a direction flip lost to a glare rollback.
          this.applyRecvPolicy();
          await this.pc.setLocalDescription();
          if (!this.closed) this.a.sendSignal(this.id, 'answer', this.pc.localDescription);
          return;
        }
      } else if (kind === 'ice') {
        if (!this.pc.remoteDescription) { if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(data); return; } // buffer (capped) until we have the description
        try { await this.pc.addIceCandidate(data); }
        catch (e) { if (!this.ignoreOffer) throw e; } // a dropped candidate after an ignored offer is expected
      }
    } catch (e) { this.a.log('voice signal error: ' + String(e)); } finally {
      if (!this.closed && this.pc.signalingState === 'stable' && this.pc.connectionState === 'connected') this.recovery.update('connected');
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audioEl) this.audioEl.volume = this.volume;
  }

  /** Route this peer's audio to an output device ('' = system default). */
  setSink(deviceId: string): void {
    this.sinkId = deviceId || '';
    this.applySink();
  }

  private applySink(): void {
    const el = this.audioEl as any;
    if (el?.setSinkId) el.setSinkId(this.sinkId).catch(() => { /* device gone — falls back to default */ });
  }

  private applyOutputMute(): void {
    const mute = this.deafened || this.locallyMuted;
    if (this.audioEl) this.audioEl.muted = mute;
    if (this.shareAudioEl) this.shareAudioEl.muted = mute; // deafen/ignore silences their screen audio too
  }

  /** Deafen: mute output without renegotiating (keeps AEC reference alive-ish). */
  setDeafened(d: boolean): void {
    this.deafened = d;
    this.applyOutputMute();
  }

  /** Locally mute (ignore) this member: silence their audio WITHOUT tearing the PC
   *  down — a teardown would have to be re-negotiated from scratch, and the remote
   *  keeps their half, so the fresh PC can't complete against their stale one. */
  setLocallyMuted(m: boolean): void {
    this.locallyMuted = m;
    this.applyOutputMute();
  }

  /** Hot-swap the outgoing audio track (device change in the no-pipeline fallback). */
  resume(): void {
    if (this.closed) return;
    this.vad?.resume();
    void this.audioEl?.play().catch(() => {});
    void this.shareAudioEl?.play().catch(() => {});
  }

  replaceAudioTrack(track: MediaStreamTrack): void {
    if (this.closed) return;
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind === 'audio' && sender !== this.shareAudioTransceiver?.sender) void sender.replaceTrack(track).catch(() => { /* ignore */ });
    }
  }

  /** Start sending our screen track to this peer (fires negotiationneeded →
   *  perfect-negotiation renegotiates). Uses addTransceiver, NOT addTrack: addTrack
   *  RECYCLES the first free same-kind transceiver — which, when the peer is already
   *  sharing, is the very m-line RECEIVING their screen. Recycling it (then forcing
   *  'sendonly') would kill both shares on this leg. addTransceiver always makes a
   *  fresh m-line, leaving their incoming share untouched. */
  private screenBitrate = SHARE_MESH_MAX_BITRATE;
  private screenCapsChain: Promise<void> = Promise.resolve();
  setScreenBitrate(kbps: number): void {
    this.screenBitrate = kbps * 1000;
    const transceiver = this.shareTransceiver;
    if (transceiver) this.screenCapsChain = this.screenCapsChain.then(async () => {
      if (this.closed || this.shareTransceiver !== transceiver) return;
      await applyShareCaps(transceiver.sender, this.screenBitrate, () => { if (this.pc.connectionState === 'connected') this.a.warn('Could not apply the screen video bitrate limit.'); });
    });
  }

  addShareTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.closed || this.shareTransceiver) return;
    this.shareTransceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    this.setScreenBitrate(this.screenBitrate / 1000);
  }

  /** Stop sending our screen track. transceiver.stop() (not removeTrack) marks the
   *  m-line closed (port 0) so its slot can be recycled by a later addTransceiver —
   *  removeTrack alone would leak a dead m-line per stop/re-share cycle. */
  removeShareTrack(): void {
    if (!this.shareTransceiver) return;
    try { this.shareTransceiver.stop(); } catch { /* stop() may be unsupported mid-negotiation */ }
    this.shareTransceiver = null;
  }

  /** Send our (echo-cancelled) screen AUDIO on its own sendonly m-line, in the SAME
   *  MediaStream as the video (so the receiver groups them by msid). Dedicated
   *  transceiver for the same reason as the video one — addTrack would recycle the
   *  m-line receiving the peer's audio. */
  addShareAudioTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.closed || this.shareAudioTransceiver) return;
    this.shareAudioTransceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
  }

  removeShareAudioTrack(): void {
    if (!this.shareAudioTransceiver) return;
    try { this.shareAudioTransceiver.stop(); } catch { /* mid-negotiation */ }
    this.shareAudioTransceiver = null;
  }

  /** Watch-on-demand: flip THEIR video m-lines between recvonly and inactive.
   *  The direction change fires negotiationneeded once stable → renegotiate. */
  setWatching(w: boolean): void {
    if (this.watching === w || this.closed) return;
    this.watching = w;
    this.applyRecvPolicy();
  }

  /** Every REMOTE video m-line: 'recvonly' while watching, else 'inactive'. Never
   *  touches our own outbound (sendonly) screen transceiver or any audio m-line. */
  private applyRecvPolicy(): void {
    for (const t of this.pc.getTransceivers()) {
      if (this.shareTransceiver && t === this.shareTransceiver) continue; // our screen going OUT
      if (t.receiver?.track?.kind !== 'video') continue;                  // audio stays untouched
      if (t.currentDirection === 'stopped' || (t as any).stopped) continue; // a stopped (dead) m-line — don't touch
      const want: RTCRtpTransceiverDirection = this.watching ? 'recvonly' : 'inactive';
      if (t.direction !== want) { try { t.direction = want; } catch { /* mid-negotiation — offer-time re-apply heals it */ } }
    }
  }

  /** True only when the audio link is up right now (else it is (re)connecting). */
  linkConnected(): boolean { return this.pc.connectionState === 'connected'; }
  /** True once the link has connected at least once — so a later drop reads as
   *  "reconnecting", while a first-time handshake shows no quality yet. */
  private everConnected = false;
  wasConnected(): boolean { return this.everConnected; }

  private lastRtp: { lost: number; recv: number } | null = null;
  /** Sample OUR link quality to this peer: round-trip time (nominated candidate
   *  pair) and the incoming-audio loss fraction over the window since the last
   *  sample. getStats can reject on a closing PC — swallow to a neutral reading. */
  async sampleQuality(): Promise<{ rttMs: number; loss: number }> {
    let rttMs = 0;
    let loss = 0;
    try {
      const stats = await this.pc.getStats();
      let curLost = 0, curRecv = 0, haveRtp = false;
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') {
          rttMs = r.currentRoundTripTime * 1000;
        } else if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          haveRtp = true;
          curLost += Number(r.packetsLost) || 0;
          curRecv += Number(r.packetsReceived) || 0;
        }
      });
      if (haveRtp) {
        if (this.lastRtp) {
          const dl = Math.max(0, curLost - this.lastRtp.lost);
          const dr = Math.max(0, curRecv - this.lastRtp.recv);
          loss = dl + dr > 0 ? dl / (dl + dr) : 0;
        }
        this.lastRtp = { lost: curLost, recv: curRecv };
      }
    } catch { /* getStats on a closing PC — leave the neutral reading */ }
    return { rttMs, loss };
  }

  close(): void {
    this.closed = true;
    this.recovery.close();
    this.vad?.stop(); this.vad = null;
    try { this.pc.close(); } catch { /* ignore */ }
    if (this.audioEl) { try { this.audioEl.srcObject = null; } catch { /* ignore */ } this.audioEl = null; }
    if (this.shareAudioEl) { try { this.shareAudioEl.srcObject = null; } catch { /* ignore */ } this.shareAudioEl = null; }
  }
}

/** One-way LOCAL loopback PC that forwards one screen track (a peer's, or our own
 *  for self-preview) into the visible main-window renderer — a MediaStream cannot
 *  cross Electron windows, but a host-candidates-only RTCPeerConnection can (no
 *  STUN, nothing leaves the machine). The engine is always the offerer and the
 *  renderer only answers, so there is no glare and no perfect negotiation here. */
class ScreenForwarder {
  private pc: RTCPeerConnection;
  private sender: RTCRtpSender | null = null;
  private closed = false;
  private graceTimer: any = null;
  private connectTimer: any = null;

  constructor(
    private send: (kind: LoopbackKind, data?: unknown) => void,
    private onDead: () => void,
    private log: (m: string) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: [] });
    // Loopback signaling crosses ipcRenderer.send (STRUCTURED clone, which throws
    // on platform objects like RTCSessionDescription) — send plain JSON shapes.
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.send('ice', candidate.toJSON()); };
    this.pc.onnegotiationneeded = async () => {
      try {
        await this.pc.setLocalDescription();
        const d = this.pc.localDescription;
        if (d) this.send('offer', { type: d.type, sdp: d.sdp });
      } catch (e) { this.log('screen forward negotiation failed: ' + String(e)); }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.die();
      // 'disconnected' = the renderer side vanished (dev reload mid-watch). Give it
      // a grace window — a reloaded renderer re-requests the watch from scratch.
      else if (s === 'disconnected') { if (!this.graceTimer) this.graceTimer = setTimeout(() => this.die(), 5000); }
      else if (s === 'connected') {
        if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      }
    };
  }

  /** Attach (or hot-swap) the forwarded screen track. A re-share swaps via
   *  replaceTrack — no renegotiation on the loopback. */
  attach(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.closed) return;
    if (this.sender) { void this.sender.replaceTrack(track).catch(() => { /* ignore */ }); return; }
    this.sender = this.pc.addTrack(track, stream); // fires negotiationneeded → offer to the renderer
    void applyShareCaps(this.sender, SHARE_LOOPBACK_MAX_BITRATE);
    // Arm the connect deadline HERE, not at construction: for a remote watch the
    // track (and thus the offer) arrives only after the mesh leg negotiates, which
    // can take >15s over TURN — reaping from construction would kill a valid watch.
    // If the renderer never answers, the loopback sits in 'new' forever, so reap it.
    if (!this.connectTimer) {
      this.connectTimer = setTimeout(() => {
        if (!this.closed && this.pc.connectionState !== 'connected') this.die();
      }, 15000);
    }
  }

  /** The renderer's answer/ICE, relayed back over IPC. */
  async onSignal(kind: 'answer' | 'ice', data: any): Promise<void> {
    if (this.closed) return;
    try {
      if (kind === 'answer') await this.pc.setRemoteDescription(data);
      else await this.pc.addIceCandidate(data);
    } catch (e) { this.log('screen forward signal error: ' + String(e)); }
  }

  close(notifyRenderer: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    try { this.pc.close(); } catch { /* ignore */ }
    if (notifyRenderer) this.send('end');
  }

  private die(): void { this.close(true); this.onDead(); }
}

export class VoiceSession {
  private active = false;
  private joining = false; // covers capture AND async pipeline initialization
  private captureGeneration = 0;
  private muted = false;
  private deafened = false;
  private mutedBeforeDeafen = false; // restore this exact mute state on un-deafen
  private inputMode: VoiceInputMode = 'always';
  private pttActive = false;         // is the push-to-talk key held right now
  private vadOpen = false;           // local VAD currently detecting speech
  private localStream: MediaStream | null = null; // PROCESSED (post-gain) stream — its track is sent to peers, gated
  private rawStream: MediaStream | null = null;   // physical mic capture feeding the pipeline (pre-gain)
  private audioCtx: AudioContext | null = null;   // capture pipeline: source → [rnnoise] → gain → destination
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private rnnoiseNode: AudioWorkletNode | null = null; // RNNoise NS worklet ('enhanced' mode), inserted src→rnnoise→gain
  private rnnoiseModuleAdded = false;             // audioWorklet.addModule('rnnoise') done for the CURRENT audioCtx
  private rnnoiseWarned = false;                   // already toasted "enhanced NS unavailable" this session (don't spam)
  private deviceRevision = 0;
  private capturedDeviceRevision = 0;
  private curCaptureKey = '';                     // captureKey() the current rawStream was REQUESTED with
  private usingFallback = false;                   // the preferred input device was absent — running on the default
  private captureBroken = false;                   // recapture failed with NO device at all — retry on the next devicechange
  private locallyMutedIds: Set<string> = new Set(); // members muted on THIS install (output cut, peer kept)
  private settingsChain: Promise<void> = Promise.resolve(); // serializes async recaptures (last write wins)
  private masterVolume = 1;                       // output master — multiplied into every per-user volume
  private vadStream: MediaStream | null = null;   // an always-open CLONE, so gating the sent track never starves the VAD
  private localVad: Vad | null = null;
  private localSpeaking = false;
  private peers = new Map<string, MediaPeer>();               // memberId → media connection
  private quality = new Map<string, { level: VoiceQuality; reconnecting: boolean }>(); // memberId → OUR link quality (getStats poll)
  private statsTimer: any = null;                             // ~3s getStats poll while in voice
  private roster = new Map<string, { muted: boolean; deafened?: boolean }>();     // OTHER members currently in voice
  private speaking = new Map<string, boolean>();              // memberId → speaking (remote)
  private volumes = new Map<string, number>();                // memberId → 0..1
  private lastStateAt = new Map<string, number>();            // memberId → last accepted voice-state timestamp (anti-replay)
  private announceAt = 0;                                      // strictly-monotonic stamp for OUR announcements
  private pendingOffers = new Map<string, unknown>();          // authenticated offer that arrived before its sender's presence (relay reorder), applied on roster (capped)
  // ── Screenshare ──
  private shareStream: MediaStream | null = null;              // OUR screen capture (engine-window getUserMedia desktop)
  private shareTrack: MediaStreamTrack | null = null;
  private shareAudioTrack: MediaStreamTrack | null = null;     // the CLEANED (echo-cancelled) screen audio we send (M20)
  private aec: ScreenAec | null = null;                        // screen-audio echo canceller (subtracts the call mix)
  private peerMicStreams = new Map<string, MediaStream>();     // memberId → their remote mic stream (AEC reference source)
  private remoteShares = new Map<string, { streamId: string }>();  // rostered members currently sharing
  private lastShareAt = new Map<string, number>();             // per-member voice-share anti-replay (separate from lastStateAt — sharing one map would let a reordered share stamp shadow a real mute change)
  private pendingShares = new Map<string, { streamId: string }>(); // share announce that beat its sender's voice-state (relay reorder), applied on roster (capped)
  private remoteTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>(); // received screen tracks by member
  private forwarders = new Map<string, ScreenForwarder>();     // open watches (memberId; selfId = self-preview)

  constructor(
    private a: VoiceAdapter,
    private now: () => number = () => Date.now(),
    private getSettings: () => VoiceSettings = defaultVoiceSettings,
  ) {}

  private screenBitrateKbps = SHARE_MESH_MAX_BITRATE / 1000;
  setScreenBitrate(kbps: number): void {
    if (!Number.isInteger(kbps) || kbps < 250 || kbps > 20_000) throw new Error('Invalid screen bitrate');
    this.screenBitrateKbps = kbps;
    for (const peer of this.peers.values()) peer.setScreenBitrate(kbps);
  }

  isActive(): boolean { return this.active; }

  /** Capture the configured mic. If the chosen device is gone, falls back to the
   *  system default WITHOUT clearing the preference (it may come back) and returns
   *  the fallback in `warning` for the UI to toast. */
  private async captureMic(s: VoiceSettings, generation = this.captureGeneration): Promise<{ stream: MediaStream; warning?: string }> {
    const base = {
      echoCancellation: s.echoCancellation,
      noiseSuppression: browserNs(s), // browser DSP only in 'standard'; 'enhanced' uses RNNoise, 'off' uses neither
      autoGainControl: s.autoGainControl,
    };
    if (s.inputDeviceId) {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: s.inputDeviceId } } }) };
      } catch (e) {
        if (generation !== this.captureGeneration) throw e;
        /* chosen mic unplugged/unavailable — fall through to default */
      }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    return { stream, warning: s.inputDeviceId ? 'Selected microphone is unavailable — using the system default.' : undefined };
  }

  /** Lazily add the RNNoise worklet module to the CURRENT AudioContext and create the
   *  node, handing it the WASM bytes. Returns null (→ caller falls back to 'standard')
   *  if the worklet/WASM can't load. RNNoise wants 48kHz — the context is built at
   *  48kHz, so no per-node resampling. */
  private async ensureRnnoiseNode(): Promise<AudioWorkletNode | null> {
    const ctx = this.audioCtx;
    if (!ctx) return null;
    if (this.rnnoiseNode) return this.rnnoiseNode;
    try {
      if (!this.rnnoiseModuleAdded) {
        const url = URL.createObjectURL(new Blob([RNNOISE_WORKLET_SOURCE], { type: 'application/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        if (this.audioCtx !== ctx) return null;
        this.rnnoiseModuleAdded = true;
      }
      const node = new AudioWorkletNode(ctx, 'rnnoise', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      // If the WASM fails to instantiate INSIDE the worklet, the processor passes
      // audio through untouched (working but unsuppressed) — warn so it isn't silent.
      node.port.onmessage = (e: MessageEvent) => {
        if (this.audioCtx === ctx && (e.data as { type?: string })?.type === 'error') {
          this.a.log('rnnoise worklet init error: ' + String((e.data as { message?: string }).message));
          this.a.warn('Enhanced noise suppression failed to start — using none.');
        }
      };
      // Decode the base64 WASM (Buffer exists in the engine preload) and post a fresh
      // copy (not transferred — we may re-init on a later context).
      const bytes = Uint8Array.from(Buffer.from(RNNOISE_WASM_BASE64, 'base64'));
      node.port.postMessage({ type: 'wasm', bytes });
      this.rnnoiseNode = node;
      return node;
    } catch (e) {
      if (this.audioCtx === ctx) this.a.log('rnnoise worklet load failed: ' + String(e));
      return null;
    }
  }

  /** Wire src → [rnnoise?] → gain for the given NS mode, keeping the SAME gain→dest
   *  edge so the sent track (dest.stream) never changes → no renegotiation. Disconnects
   *  the source's old fan-out first. RNNoise unavailability silently degrades to a
   *  direct src→gain (browser 'standard' NS is separately requested at capture time). */
  private async connectGraph(mode: NoiseSuppressionMode): Promise<void> {
    const ctx = this.audioCtx, src = this.srcNode, gain = this.gainNode;
    if (!ctx || !src || !gain) return;
    try { src.disconnect(); } catch { /* ignore */ }
    if (this.rnnoiseNode) { try { this.rnnoiseNode.disconnect(); } catch { /* ignore */ } }
    let rnnoiseFailed = false;
    if (mode === 'enhanced') {
      const node = await this.ensureRnnoiseNode();
      if (this.audioCtx !== ctx || this.srcNode !== src || this.gainNode !== gain) return;
      // ensureRnnoiseNode awaits addModule — a leave() may have torn the graph down
      // meanwhile; bail if so (the caller re-checks active too).
      if (node) {
        src.connect(node);
        node.connect(gain);
        this.rnnoiseWarned = false; // a later failure should warn again
        return;
      }
      if (!this.audioCtx || !this.srcNode || !this.gainNode) return; // torn down mid-await
      rnnoiseFailed = true;
    }
    // 'off' / 'standard' / enhanced-fallback: straight through. NOTE: on the enhanced
    // fallback there is NO browser NS either (captureMic requested it off), so the
    // honest message is "none", not "standard". Warn once per session (a persistently
    // failing addModule would otherwise re-warn on every capture-key change).
    src.connect(gain);
    if (rnnoiseFailed && !this.rnnoiseWarned) {
      this.rnnoiseWarned = true;
      this.a.warn('Enhanced noise suppression is unavailable — noise suppression is off.');
    }
  }

  /** Build the capture pipeline: raw mic → [rnnoise] → gain → sent stream. Async
   *  because 'enhanced' must await audioWorklet.addModule. On Web Audio failure the raw
   *  stream is sent directly (gain then has no effect). AudioContext is pinned to 48kHz
   *  for RNNoise (Chromium resamples the mic input to the context rate). */
  private async buildPipeline(raw: MediaStream, s: VoiceSettings): Promise<MediaStream> {
    let ctx: AudioContext | null = null;
    let output: MediaStream | null = null;
    try {
      ctx = new AudioContext({ sampleRate: 48000 });
      this.audioCtx = ctx;
      this.rnnoiseNode = null;
      this.rnnoiseModuleAdded = false;
      void this.audioCtx.resume().catch(() => { /* ignore */ });
      this.srcNode = this.audioCtx.createMediaStreamSource(raw);
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = s.inputGain;
      const dest = this.audioCtx.createMediaStreamDestination();
      output = dest.stream;
      this.gainNode.connect(dest);
      await this.connectGraph(s.noiseSuppressionMode);
      if (this.audioCtx !== ctx) output.getTracks().forEach((t) => t.stop());
      return dest.stream;
    } catch {
      output?.getTracks().forEach((t) => t.stop());
      if (this.audioCtx === ctx) {
        this.audioCtx = null; this.srcNode = null; this.gainNode = null; this.rnnoiseNode = null;
      }
      try { void ctx?.close().catch(() => { /* already closed */ }); } catch { /* ignore */ }
      return raw;
    }
  }

  async join(): Promise<string | undefined> {
    if (this.active || this.joining) return; // guard the in-flight getUserMedia too (no double stream)
    // navigator.mediaDevices is undefined outside a secure context — surface a
    // clear error instead of a cryptic "cannot read getUserMedia of undefined".
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone unavailable (the room engine is not a secure context).');
    }
    const s = this.getSettings();
    const generation = ++this.captureGeneration;
    const deviceRevision = this.deviceRevision;
    this.joining = true;
    let warning: string | undefined;
    try {
      const cap = await this.captureMic(s, generation);
      if (generation !== this.captureGeneration) { cap.stream.getTracks().forEach((t) => t.stop()); return; }
      this.rawStream = cap.stream;
      warning = cap.warning;
      this.curCaptureKey = captureKey(s);
      this.capturedDeviceRevision = deviceRevision;
      this.usingFallback = !!warning;
      this.captureBroken = false;
      this.watchRawTrack(); // a mid-call unplug ends the track — recapture instead of going silent
      this.masterVolume = s.masterVolume;
      const local = await this.buildPipeline(cap.stream, s);
      if (generation !== this.captureGeneration) { local.getTracks().forEach((t) => t.stop()); return; }
      this.localStream = local;
      this.active = true;
      // muted/deafened deliberately PERSIST across leave/rejoin within the session
      // (Discord convention — leaving muted and hopping back shouldn't hot-mic you).
      this.pttActive = false;
      this.vadOpen = false;
      this.applyTransmit();
      // Run VAD on an always-open CLONE of the sent (post-gain) track: gating the
      // SENT track via enabled=false makes it emit silence, which would starve a VAD
      // reading that same track ('vad' mode would latch shut). The clone shares the
      // source but keeps its own enabled=true, so voice-activity gating can re-open.
      // Force-enable it: a clone inherits the source track's enabled state, so
      // rejoining while MUTED would otherwise clone a disabled (silent) track and the
      // VAD would never open after un-muting.
      const clone = this.localStream.getAudioTracks()[0]?.clone();
      if (clone) clone.enabled = true;
      this.vadStream = clone ? new MediaStream([clone]) : null;
      this.localVad = this.vadStream
        ? new Vad(this.vadStream, (vs) => this.onVad(vs), this.now, s.vadThreshold)
        : null;
      this.a.announce(true, this.muted, this.nextAt(), this.deafened);
      this.reconcilePeers();
      if (!this.statsTimer) this.statsTimer = setInterval(() => { void this.pollQuality(); }, QUALITY_POLL_MS);
      this.a.onChange();
      // Settings may have changed while getUserMedia was in flight (the engine's
      // room-cmd handler is not serialized across awaits). Reconcile BOTH the live
      // knobs (gain/volume/VAD — built above from the pre-await snapshot) and the
      // capture config against the latest settings.
      this.applySettings();
      return warning;
    } catch (e) {
      if (generation !== this.captureGeneration) return;
      this.leave();
      throw e;
    } finally {
      if (generation === this.captureGeneration) this.joining = false;
    }
  }

  leave(): void {
    ++this.captureGeneration;
    const wasActive = this.active;
    const wasJoining = this.joining;
    this.joining = false;
    this.settingsChain = Promise.resolve();
    if (!wasActive && !wasJoining) return;
    this.active = false;
    // Screenshare teardown FIRST: release the capture before closing PCs, close
    // every open watch ('end' → the renderer overlay closes), drop share state.
    // No separate announceShare(false) — receivers clear sharing on inVoice:false.
    this.aec?.close(); this.aec = null;
    this.shareAudioTrack?.stop(); this.shareAudioTrack = null;
    this.peerMicStreams.clear();
    this.shareStream?.getTracks().forEach((t) => t.stop());
    this.shareStream = null; this.shareTrack = null;
    for (const f of this.forwarders.values()) f.close(true);
    this.forwarders.clear();
    this.remoteTracks.clear();
    this.remoteShares.clear();
    this.pendingShares.clear();
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.quality.clear();
    this.localVad?.stop(); this.localVad = null;
    this.vadStream?.getTracks().forEach((t) => t.stop());
    this.vadStream = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    // Release the physical mic + the gain pipeline (localStream is only the
    // pipeline's destination — the OS capture lives on rawStream).
    this.rawStream?.getTracks().forEach((t) => t.stop());
    this.rawStream = null;
    try { this.srcNode?.disconnect(); } catch { /* ignore */ }
    try { this.rnnoiseNode?.disconnect(); } catch { /* ignore */ }
    try { this.rnnoiseNode?.port.close(); } catch { /* ignore */ }
    this.srcNode = null; this.gainNode = null; this.rnnoiseNode = null; this.rnnoiseModuleAdded = false; this.rnnoiseWarned = false;
    try { void this.audioCtx?.close().catch(() => { /* already closed */ }); } catch { /* ignore */ }
    this.audioCtx = null;
    this.curCaptureKey = '';
    this.captureBroken = false;
    this.localSpeaking = false;
    this.vadOpen = false;
    this.pttActive = false;
    this.speaking.clear();
    this.pendingOffers.clear();
    if (wasActive) this.a.announce(false, false, this.nextAt(), false);
    this.a.onChange();
  }

  /** Global voice settings changed (engine store). Live knobs apply instantly;
   *  capture-affecting ones (device / EC / NS / AGC) trigger a serialized hot
   *  recapture that swaps the pipeline SOURCE — the sent track never changes, so
   *  no renegotiation and no replaceTrack. */
  applySettings(): void {
    const s = this.getSettings();
    this.masterVolume = s.masterVolume;
    if (this.gainNode) this.gainNode.gain.value = s.inputGain;
    this.localVad?.setThreshold(s.vadThreshold);
    for (const [id, p] of this.peers) {
      p.setSink(s.outputDeviceId || '');
      p.setVolume(this.effectiveVolume(id));
    }
    if (this.active) {
      this.settingsChain = this.settingsChain.then(() => this.recaptureIfNeeded()).catch(() => { /* ignore */ });
    }
  }

  /** The physical mic feeding the pipeline ended (unplugged / hub slept). Recapture
   *  (falls back to the system default) instead of silently transmitting silence. */
  private watchRawTrack(): void {
    const track = this.rawStream?.getAudioTracks()[0];
    if (!track) return;
    track.onended = () => {
      if (!this.active || this.rawStream?.getAudioTracks()[0] !== track) return;
      this.captureBroken = true; this.localSpeaking = false; this.applyTransmit(); this.a.onChange();
      this.curCaptureKey = ''; // force recaptureIfNeeded past its equality guard
      this.settingsChain = this.settingsChain.then(() => this.recaptureIfNeeded()).catch(() => { /* ignore */ });
    };
  }

  /** An audio device came or went (engine 'devicechange'). Retry capture if we're
   *  on the fallback default (the preferred device may have returned) OR capture is
   *  broken entirely (the only input was unplugged — a returning device recovers us). */
  onDevicesChanged(): void {
    if (!this.active) return;
    // Default-device changes can switch input without ending the old track.
    this.applySettings(); // also reapply the preferred output sink after hardware changes
    if (this.captureBroken || !this.getSettings().inputDeviceId || this.usingFallback) {
      ++this.deviceRevision;
      this.curCaptureKey = '';
      this.settingsChain = this.settingsChain.then(() => this.recaptureIfNeeded()).catch(() => { /* ignore */ });
    }
  }

  /** Swap the mic feeding the pipeline if the requested capture config drifted
   *  from what we captured with. Keyed on the REQUESTED config (not the actual
   *  device used), so an unavailable-device fallback doesn't retry forever. */
  private async recaptureIfNeeded(): Promise<void> {
    if (!this.active) return;
    const generation = this.captureGeneration;
    const s = this.getSettings();
    const key = captureKey(s);
    const deviceRevision = this.deviceRevision;
    if (key === this.curCaptureKey && deviceRevision === this.capturedDeviceRevision) return;
    let cap: { stream: MediaStream; warning?: string };
    // A total capture failure (no device at all) leaves us silent — flag it so a
    // later devicechange retries (usingFallback wouldn't latch, blocking recovery).
    try { cap = await this.captureMic(s, generation); }
    catch (e) {
      if (generation === this.captureGeneration) { this.a.log('voice recapture failed: ' + String(e)); this.captureBroken = !this.rawStream?.getAudioTracks()[0] || this.rawStream.getAudioTracks()[0].readyState === 'ended'; this.a.onChange(); }
      return;
    }
    const fresh = cap.stream;
    if (!this.active || generation !== this.captureGeneration) { fresh.getTracks().forEach((t) => t.stop()); return; }
    this.captureBroken = false;
    this.curCaptureKey = key;
    this.capturedDeviceRevision = deviceRevision;
    const wasFallback = this.usingFallback;
    this.usingFallback = !!cap.warning;
    if (cap.warning && !wasFallback) this.a.warn(cap.warning); // loud at join, now loud mid-call too
    const old = this.rawStream;
    this.rawStream = fresh;
    this.watchRawTrack();
    old?.getTracks().forEach((t) => t.stop());
    if (this.audioCtx && this.gainNode) {
      // Re-source and re-wire the graph for the current NS mode, keeping the SAME
      // gainNode + dest (so the sent track / localStream is unchanged → no
      // renegotiation), only inserting/removing the RNNoise node as the mode requires.
      // Disconnect the OUTGOING source first — connectGraph disconnects this.srcNode,
      // which we're about to overwrite, so it can't reach the old node.
      try { this.srcNode?.disconnect(); } catch { /* ignore */ }
      this.srcNode = this.audioCtx.createMediaStreamSource(fresh);
      await this.connectGraph(s.noiseSuppressionMode);
      // connectGraph may have awaited addModule; a leave() could have run meanwhile.
      if (!this.active || generation !== this.captureGeneration) { fresh.getTracks().forEach((t) => t.stop()); return; }
    } else {
      // No-pipeline fallback (Web Audio failed at join): the raw track IS the sent
      // track — swap it on every live sender and rebuild the VAD on the new track.
      const track = fresh.getAudioTracks()[0];
      if (track) {
        // Gate before replaceTrack: mute/deafen/PTT must never leak on recapture.
        track.enabled = this.transmitting();
        this.localStream = fresh;
        for (const p of this.peers.values()) p.replaceAudioTrack(track);
        this.localVad?.stop();
        this.vadStream?.getTracks().forEach((t) => t.stop());
        const clone = track.clone(); clone.enabled = true;
        this.vadStream = clone ? new MediaStream([clone]) : null;
        this.localVad = this.vadStream ? new Vad(this.vadStream, (vs) => this.onVad(vs), this.now, s.vadThreshold) : null;
        this.applyTransmit();
      }
    }
    this.applyTransmit(); this.a.onChange();
  }

  private effectiveVolume(memberId: string): number {
    return this.masterVolume * (this.volumes.get(memberId) ?? 1);
  }

  setMuted(muted: boolean): void {
    if (!this.active || this.muted === muted) return;
    this.muted = muted;
    this.applyTransmit();
    this.a.announce(true, this.muted, this.nextAt(), this.deafened);
    this.a.onChange();
  }

  setDeafened(deafened: boolean): void {
    if (!this.active || this.deafened === deafened) return;
    this.deafened = deafened;
    for (const p of this.peers.values()) p.setDeafened(deafened);
    this.updateAecRefs(); // deafened → nothing is played → the echo reference goes silent
    if (deafened) {
      // Deafening also mutes your mic (Discord convention); remember the prior mute
      // state so un-deafening restores it exactly (not force-unmute).
      this.mutedBeforeDeafen = this.muted;
      if (!this.muted) { this.muted = true; this.applyTransmit(); }
    } else {
      if (this.muted !== this.mutedBeforeDeafen) { this.muted = this.mutedBeforeDeafen; this.applyTransmit(); }
    }
    this.a.announce(true, this.muted, this.nextAt(), this.deafened);
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
    this.peers.get(memberId)?.setVolume(this.effectiveVolume(memberId));
    const ms = this.peerMicStreams.get(memberId);
    if (this.aec && ms) this.aec.setReference(memberId, ms, this.refGain(memberId)); // keep the echo reference in sync
  }

  /** Locally mute (ignore) a member: silence their audio without tearing the media
   *  connection down. `memberId==null` re-applies the whole set (after ensurePeer
   *  rebuilds a peer). */
  setLocallyMuted(muted: Set<string>): void {
    this.locallyMutedIds = muted;
    for (const [id, p] of this.peers) p.setLocallyMuted(muted.has(id));
    this.updateAecRefs(); // a muted member is no longer heard → drop them from the echo reference
  }

  // ── Screenshare ──

  isSharing(): boolean { return !!this.shareStream; }

  /** Start sharing an already-captured screen stream (the engine captured it via
   *  chromeMediaSource; we own it from here). Idempotent while a share is live. */
  startShare(stream: MediaStream): void {
    if (!this.active) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Join the voice channel before sharing your screen.'); }
    if (this.shareStream) { stream.getTracks().forEach((t) => t.stop()); return; }
    const track = stream.getVideoTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Screen capture produced no video track.'); }
    try { track.contentHint = 'detail'; } catch { /* hint is best-effort */ }
    // The captured window/display can vanish (user closes the shared app) — auto-stop.
    track.onended = () => { if (this.shareStream) this.stopShare(); };
    this.shareStream = stream;
    this.shareTrack = track;
    for (const p of this.peers.values()) p.addShareTrack(track, stream); // → renegotiate per peer
    this.a.announceShare(true, stream.id, this.nextAt());
    this.a.onChange();
    // M20: if the capture also carries system audio, echo-cancel it and share the
    // cleaned track (async — the AEC worklet loads, then the audio m-line adds).
    if (stream.getAudioTracks().length) void this.startShareAudio(stream);
  }

  /** Echo-cancel the captured system audio (subtract the call mix we play) and fan
   *  the CLEANED track out on a second m-line, grouped with the video by msid. On
   *  AEC failure we share video only — sending the raw loopback would echo the call. */
  private async startShareAudio(stream: MediaStream): Promise<void> {
    const raw = stream.getAudioTracks()[0];
    if (!raw) return;
    let aec: ScreenAec | null = null;
    try { aec = await ScreenAec.create(stream, AEC_TAPS, (m) => this.a.log(m)); }
    catch (e) { this.a.log('screen AEC create threw: ' + String(e)); }
    // Share stopped / replaced while the worklet loaded, or AEC unavailable → drop audio.
    if (!this.active || this.shareStream !== stream || !aec) { aec?.close(); return; }
    const cleaned = aec.outputTrack;
    if (!cleaned) { aec.close(); return; }
    this.aec = aec;
    this.shareAudioTrack = cleaned;
    // Seed the reference with everyone we currently hear (at their play volume).
    for (const [id, ms] of this.peerMicStreams) aec.setReference(id, ms, this.refGain(id));
    for (const p of this.peers.values()) p.addShareAudioTrack(cleaned, stream); // → renegotiate
    this.a.log('screen audio: sharing echo-cancelled system audio');
    this.a.onChange();
  }

  stopShare(): void {
    if (!this.shareStream) return;
    for (const p of this.peers.values()) { p.removeShareTrack(); p.removeShareAudioTrack(); } // → renegotiate
    this.aec?.close(); this.aec = null;
    this.shareAudioTrack?.stop(); this.shareAudioTrack = null;
    this.shareStream.getTracks().forEach((t) => t.stop());
    this.shareStream = null;
    this.shareTrack = null;
    this.closeForwarder(this.a.selfId); // self-preview, if open
    this.a.announceShare(false, '', this.nextAt());
    this.a.onChange();
  }

  /** Signed voice-share gossip: `memberId` started/stopped sharing. Same monotonic
   *  `at` discipline as voice-state, with its OWN per-member replay map. */
  onPeerShare(memberId: string, sharing: boolean, streamId: string, at: number): void {
    if (memberId === this.a.selfId) return;
    if (!acceptVoiceStamp(this.lastShareAt, memberId, at, this.now())) return;
    if (!this.roster.has(memberId)) {
      // Their voice-state hasn't landed yet (unordered flood) — buffer the LATEST
      // announce (bounded), applied when they roster in onPeerState.
      if (!sharing) { this.pendingShares.delete(memberId); return; }
      if (this.pendingShares.size >= MAX_VOICE_PEERS && !this.pendingShares.has(memberId)) return;
      this.pendingShares.set(memberId, { streamId });
      return;
    }
    this.applyPeerShare(memberId, sharing, streamId);
  }

  private applyPeerShare(memberId: string, sharing: boolean, streamId: string): void {
    if (sharing) {
      this.remoteShares.set(memberId, { streamId });
      this.peers.get(memberId)?.setShareStreamId(streamId); // route their screen audio (M20)
    } else {
      this.remoteShares.delete(memberId);
      this.remoteTracks.delete(memberId);
      this.peers.get(memberId)?.setShareStreamId('');
      this.closeForwarder(memberId);              // share ended while we watched → 'end' closes the overlay
      this.peers.get(memberId)?.setWatching(false); // stop paying recv bandwidth for a dead m-line
    }
    this.a.onChange();
  }

  /** The renderer wants to view `memberId`'s share (or our own — self-preview). */
  watchStart(memberId: string): void {
    if (memberId === this.a.selfId) {
      if (!this.shareStream || !this.shareTrack) throw new Error('You are not sharing your screen.');
    } else {
      if (!this.active) throw new Error('Join the voice channel to watch a screen share.');
      if (!this.remoteShares.has(memberId)) throw new Error('This member is not sharing their screen.');
    }
    this.closeForwarder(memberId, false); // re-watch: replace with a fresh forwarder, silently
    if (this.forwarders.size >= MAX_VOICE_PEERS) throw new Error('Too many open screen views.');
    const f = new ScreenForwarder(
      (kind, data) => this.a.sendLoopback(memberId, kind, data),
      () => { this.forwarders.delete(memberId); if (memberId !== this.a.selfId) this.peers.get(memberId)?.setWatching(false); },
      (m) => this.a.log(m),
    );
    this.forwarders.set(memberId, f);
    if (memberId === this.a.selfId) {
      f.attach(this.shareTrack!, this.shareStream!); // local track — no mesh recv involved
    } else {
      this.peers.get(memberId)?.setWatching(true);   // 'inactive' → 'recvonly' → renegotiate
      const rt = this.remoteTracks.get(memberId);
      if (rt) f.attach(rt.track, rt.stream);         // track may already be flowing; else attached on arrival
    }
  }

  watchStop(memberId: string): void {
    this.closeForwarder(memberId, false); // the renderer asked — no 'end' echo needed
    if (memberId !== this.a.selfId) this.peers.get(memberId)?.setWatching(false);
  }

  /** The renderer's loopback answer/ICE for an open watch. */
  onLoopbackSignal(memberId: string, kind: string, data: unknown): void {
    if (kind !== 'answer' && kind !== 'ice') return;
    void this.forwarders.get(memberId)?.onSignal(kind, data as any);
  }

  private closeForwarder(memberId: string, notify = true): void {
    const f = this.forwarders.get(memberId);
    if (f) { this.forwarders.delete(memberId); f.close(notify); }
  }

  /** A peer's screen track arrived (or ended) on its MediaPeer. Both orders work:
   *  watch-then-track attaches here; track-then-watch attaches in watchStart. */
  private setRemoteShareTrack(memberId: string, track: MediaStreamTrack | null, stream: MediaStream | null): void {
    if (!track || !stream) {
      this.remoteTracks.delete(memberId);
      this.closeForwarder(memberId); // 'end' → the renderer overlay closes
      return;
    }
    this.remoteTracks.set(memberId, { track, stream });
    this.forwarders.get(memberId)?.attach(track, stream);
  }

  private onVad(open: boolean): void {
    this.vadOpen = open;
    if (this.inputMode === 'vad') this.applyTransmit(); // gate the sent track on speech
    const speaking = this.transmitting() && open;
    if (speaking !== this.localSpeaking) { this.localSpeaking = speaking; this.a.onChange(); }
  }

  /** Are we sending audio right now (open + not gated by mode)? */
  private transmitting(): boolean {
    if (!this.active || this.muted || this.deafened || this.captureBroken || !this.meshMembers().has(this.a.selfId)) return false;
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
  onPeerState(memberId: string, inVoice: boolean, muted: boolean, at: number, deafened = false): void {
    if (memberId === this.a.selfId) return;
    if (!acceptVoiceStamp(this.lastStateAt, memberId, at, this.now())) return;
    const previous = this.roster.get(memberId);
    const had = !!previous;
    if (inVoice) {
      // Cap: don't let unlimited (possibly fabricated) identities grow the roster.
      if (!had && this.roster.size >= ROOM_VOICE_ROSTER) { this.a.log('voice roster full — ignoring ' + memberId.slice(0, 8)); return; }
      this.roster.set(memberId, { muted, deafened });
      // A voice-share that beat this voice-state (unordered flood) applies now.
      const pend = this.pendingShares.get(memberId);
      if (pend) { this.pendingShares.delete(memberId); this.applyPeerShare(memberId, true, pend.streamId); }
    } else {
      this.roster.delete(memberId); this.speaking.delete(memberId);
      // Leaving voice implies their share ended (no separate announce is sent).
      this.pendingShares.delete(memberId); this.pendingOffers.delete(memberId);
      if (this.remoteShares.has(memberId)) this.applyPeerShare(memberId, false, '');
    }
    this.reconcilePeers();
    if (had !== inVoice || this.active || inVoice && (previous?.muted !== muted || previous?.deafened !== deafened)) this.a.onChange();
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
    if (kind === 'offer' && (this.pendingOffers.has(from) || this.pendingOffers.size < MAX_VOICE_PEERS)) this.pendingOffers.set(from, data);
  }

  /** A member left the ROOM entirely — drop them from voice too. NOTE: the
   *  anti-replay stamps (lastStateAt/lastShareAt) are deliberately KEPT — deleting
   *  them re-opens a replay window (a captured old signed inVoice/sharing:true would
   *  verify against a cleared floor and resurrect a ghost). They're monotonic
   *  floors, so a legitimate later re-announce (higher `at`) still passes; only a
   *  stale replay is blocked. Bounded without evicting a remembered floor. */
  onMemberGone(memberId: string): void {
    this.pendingOffers.delete(memberId);
    this.pendingShares.delete(memberId);
    const hadShare = this.remoteShares.delete(memberId);
    this.remoteTracks.delete(memberId);
    this.closeForwarder(memberId); // watching their now-dead share → overlay closes
    if (!this.roster.has(memberId) && !this.peers.has(memberId) && !hadShare) return;
    this.roster.delete(memberId);
    this.speaking.delete(memberId);
    this.dropPeer(memberId);
    this.reconcilePeers();
    this.a.onChange();
  }

  /** Re-broadcast our presence (call when a NEW member appears, so a late joiner
   *  learns we're already in voice — presence is only gossiped on change). Always
   *  emits the CURRENT share truth (including sharing:false) so any hello corrects a
   *  member whose LIVE badge was set by a replayed voice-share. */
  reannounce(): void {
    if (!this.active) return;
    this.a.announce(true, this.muted, this.nextAt(), this.deafened);
    this.a.announceShare(this.isSharing(), this.shareStream?.id || '', this.nextAt());
  }

  /** VPN kill-switch / room teardown: fully stop voice (releases the mic). */
  suspend(): void { this.leave(); }

  private meshMembers(): Set<string> { return voiceMeshMembers(this.a.selfId, this.active, this.roster.keys()); }

  private reconcilePeers(): void {
    const admitted = this.meshMembers();
    for (const id of this.peers.keys()) {
      if (!this.active || !admitted.has(this.a.selfId) || !admitted.has(id)) {
        this.closeForwarder(id); this.remoteTracks.delete(id); this.dropPeer(id);
      }
    }
    if (this.active && admitted.has(this.a.selfId)) for (const id of admitted) {
      if (id !== this.a.selfId) this.ensurePeer(id);
    }
    this.applyTransmit();
  }

  private ensurePeer(memberId: string): MediaPeer | undefined {
    const admitted = this.meshMembers();
    if (!this.active || !admitted.has(this.a.selfId) || !admitted.has(memberId)) return;
    let p = this.peers.get(memberId);
    if (!p && this.localStream) {
      if (this.peers.size >= MAX_VOICE_PEERS) { this.a.log('voice peer cap reached — not connecting ' + memberId.slice(0, 8)); return undefined; }
      // Deterministic polite/impolite split by id so exactly one side wins glare.
      const polite = this.a.selfId > memberId;
      p = new MediaPeer(
        memberId, polite, this.a, this.localStream,
        (s) => this.setSpeaking(memberId, s),
        (track, stream) => this.setRemoteShareTrack(memberId, track, stream),
        () => this.a.onChange(),
        (stream) => this.onPeerMicStream(memberId, stream),
        this.now,
      );
      p.setSink(this.getSettings().outputDeviceId || '');
      p.setVolume(this.effectiveVolume(memberId));
      if (this.deafened) p.setDeafened(true);
      if (this.locallyMutedIds.has(memberId)) p.setLocallyMuted(true);
      // Mid-share join: attach the live screen track BEFORE the pending offer is
      // applied, so the fresh (stable) PC carries it in its very first negotiation.
      p.setScreenBitrate(this.screenBitrateKbps);
      if (this.shareTrack && this.shareStream) p.addShareTrack(this.shareTrack, this.shareStream);
      if (this.shareAudioTrack && this.shareStream) p.addShareAudioTrack(this.shareAudioTrack, this.shareStream);
      // They already announced a share → route their screen audio by that streamId.
      const rs = this.remoteShares.get(memberId);
      if (rs) p.setShareStreamId(rs.streamId);
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
    this.peerMicStreams.delete(memberId);
    this.aec?.removeReference(memberId); // stop feeding a gone peer into the echo reference
  }

  // ── Screen-audio echo cancellation (M20) ─────────────────────────────────────
  /** A peer's mic stream arrived/ended. While WE share system audio, that stream is
   *  part of what the desktop loopback re-captures, so it must be in the AEC
   *  reference (at the volume we play it) to be cancelled out of the shared audio. */
  private onPeerMicStream(memberId: string, stream: MediaStream | null): void {
    if (stream) this.peerMicStreams.set(memberId, stream); else this.peerMicStreams.delete(memberId);
    if (!this.aec) return;
    if (stream) this.aec.setReference(memberId, stream, this.refGain(memberId));
    else this.aec.removeReference(memberId);
  }

  /** The gain a peer's voice is actually PLAYED at (so the reference matches the
   *  loopback): zero when deafened or this member is locally muted. */
  private refGain(memberId: string): number {
    if (this.deafened || this.locallyMutedIds.has(memberId)) return 0;
    return this.effectiveVolume(memberId);
  }

  /** Re-apply every reference gain (after a volume / deafen / local-mute change). */
  private updateAecRefs(): void {
    if (!this.aec) return;
    for (const [id, ms] of this.peerMicStreams) this.aec.setReference(id, ms, this.refGain(id));
  }

  /** Explicit retry keeps microphone, mute, gain, output routing and screen tracks. */
  reconnect(): void {
    if (!this.active) return;
    for (const p of this.peers.values()) { p.resume(); p.recovery.retry(); }
    this.localVad?.resume();
    if (this.captureBroken) { this.curCaptureKey = ''; this.applySettings(); }
    void this.audioCtx?.resume().catch(() => {});
    this.reannounce();
  }

  onNetworkChanged(): void {
    if (!this.active) return;
    for (const p of this.peers.values()) { p.resume(); p.recovery.networkChanged(); }
    this.localVad?.resume();
    void this.audioCtx?.resume().catch(() => {});
    this.reannounce();
  }

  private setSpeaking(memberId: string, s: boolean): void {
    if ((this.speaking.get(memberId) ?? false) === s) return;
    this.speaking.set(memberId, s);
    this.a.onChange();
  }

  /** Sample OUR link quality to every peer (RTT + loss) and flag reconnecting
   *  ones, then push if anything changed. Runs every QUALITY_POLL_MS while in
   *  voice. A peer that has never connected yet gets NO entry (no dot); one that
   *  connected and then dropped reads as poor + reconnecting. */
  private async pollQuality(): Promise<void> {
    if (!this.active) return;
    let changed = false;
    const seen = new Set<string>();
    const generation = this.captureGeneration;
    for (const [id, p] of this.peers) {
      let entry: { level: VoiceQuality; reconnecting: boolean } | null = null;
      if (p.linkConnected()) {
        const { rttMs, loss } = await p.sampleQuality();
        if (!this.active || generation !== this.captureGeneration) return;
        if (this.peers.get(id) !== p) continue;
        const level: VoiceQuality = (rttMs > RTT_POOR_MS || loss > LOSS_POOR) ? 'poor'
          : (rttMs > RTT_FAIR_MS || loss > LOSS_FAIR) ? 'fair' : 'good';
        entry = { level, reconnecting: false };
      } else if (p.wasConnected()) {
        entry = { level: 'poor', reconnecting: true }; // dropped, re-establishing
      }
      if (!entry) continue; // still doing the first handshake — no dot yet
      seen.add(id);
      const prev = this.quality.get(id);
      if (!prev || prev.level !== entry.level || prev.reconnecting !== entry.reconnecting) changed = true;
      this.quality.set(id, entry);
    }
    for (const id of Array.from(this.quality.keys())) if (!seen.has(id)) { this.quality.delete(id); changed = true; } // gone / torn down
    if (changed) this.a.onChange();
  }

  getState(): VoiceState {
    const participants: VoiceParticipant[] = [];
    const admitted = this.meshMembers();
    if (this.active) participants.push({ memberId: this.a.selfId, muted: this.muted, deafened: this.deafened, ...(!admitted.has(this.a.selfId) ? { waitingForSlot: true } : {}), speaking: this.localSpeaking && !this.muted, sharing: this.isSharing() });
    for (const [id, st] of this.roster) {
      const q = this.quality.get(id);
      participants.push({
        memberId: id, ...(!admitted.has(id) ? { waitingForSlot: true } : {}), muted: st.muted, deafened: !!st.deafened, speaking: !!this.speaking.get(id) && !st.muted, sharing: this.remoteShares.has(id),
        ...(q ? { quality: q.level, ...(q.reconnecting ? { reconnecting: true } : {}) } : {}),
        ...(this.active && this.peers.has(id) ? { connection: this.peers.get(id)!.recovery.state,
          reconnectAttempts: this.peers.get(id)!.recovery.attempts } : {}),
      });
    }
    return { inVoice: this.active, muted: this.muted, deafened: this.deafened, transmitting: this.transmitting(), inputMode: this.inputMode, sharing: this.isSharing(), participants, ...(this.active && this.captureBroken ? { micUnavailable: true } : {}) };
  }
}

// Mic test auto-stop: don't hold the mic forever if the renderer dies with the
// settings modal open (its stop() would never arrive).
const MIC_TEST_MAX_MS = 60_000;

/** Create a one-off RNNoise worklet node on `ctx` (own module + WASM), or null
 *  if it can't load. Standalone twin of VoiceSession.ensureRnnoiseNode — used by
 *  the mic test's monitor path so "hear yourself" reflects the SAME enhanced
 *  suppression a real call applies (no shared caching; the tester is short-lived). */
async function makeRnnoiseNode(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  try {
    const url = URL.createObjectURL(new Blob([RNNOISE_WORKLET_SOURCE], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(ctx, 'rnnoise', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const bytes = Uint8Array.from(Buffer.from(RNNOISE_WASM_BASE64, 'base64'));
    node.port.postMessage({ type: 'wasm', bytes });
    return node;
  } catch { return null; }
}

/** Standalone mic level meter for the settings UI. Captures the CONFIGURED mic
 *  and reports the RAW (pre-gain) 0-255 average level every poll — the renderer
 *  multiplies the displayed bar by the gain slider, so dragging gain never forces
 *  a recapture. Independent of any VoiceSession — works outside a call; opening
 *  the same device twice while in a call is fine in Chromium. */
export class MicTester {
  private stream: MediaStream | null = null;
  private vad: Vad | null = null;
  private stopTimer: any = null;
  private onEnded: (() => void) | null = null;
  private seq = 0; // invalidates a start() that lost a race with stop()/restart
  private monitorCtx: AudioContext | null = null; // "hear yourself" playback graph
  private monitorEl: HTMLAudioElement | null = null; // its sink (honors the chosen output device)

  /** `onEnded` fires when the test stops ON ITS OWN (the 60s deadline) so the UI can
   *  drop out of its "testing" state — an explicit stop() is caller-driven and does
   *  NOT fire it. `monitor` plays the PROCESSED mic back through the speakers so the
   *  user can hear the current noise-suppression mode (headphones recommended — on
   *  speakers the mic re-captures the playback). */
  async start(s: VoiceSettings, onLevel: (level: number) => void, onEnded?: () => void, monitor = false): Promise<void> {
    this.stop(); // also bumps seq, invalidating any in-flight start
    const mySeq = ++this.seq;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone unavailable (the room engine is not a secure context).');
    }
    // The meter reflects the mic BEFORE the enhanced (RNNoise) stage — it uses the
    // same browser constraints the pipeline would (browser NS only in 'standard').
    const base = { echoCancellation: s.echoCancellation, noiseSuppression: browserNs(s), autoGainControl: s.autoGainControl };
    let stream: MediaStream;
    try {
      stream = s.inputDeviceId
        ? await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: s.inputDeviceId } } })
        : await navigator.mediaDevices.getUserMedia({ audio: base });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: base }); // chosen mic gone — meter the default
    }
    if (mySeq !== this.seq) { stream.getTracks().forEach((t) => t.stop()); return; } // superseded while capturing
    this.stream = stream;
    this.onEnded = onEnded || null;
    this.vad = new Vad(stream, () => { /* meter only */ }, () => Date.now(), s.vadThreshold, onLevel);
    if (monitor) { void this.startMonitor(stream, s, mySeq); }
    this.stopTimer = setTimeout(() => { const cb = this.onEnded; this.stop(); cb?.(); }, MIC_TEST_MAX_MS);
  }

  /** Build src → [rnnoise?] → gain → <audio> so the user hears exactly what the
   *  selected NS mode produces (the enhanced RNNoise stage included). Playback goes
   *  through an audio element + setSinkId — NOT ctx.destination — so it lands on the
   *  CHOSEN output device, the same path remote voice already uses. */
  private async startMonitor(stream: MediaStream, s: VoiceSettings, mySeq: number): Promise<void> {
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      void ctx.resume().catch(() => { /* ignore */ });
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = s.inputGain;
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      let head: AudioNode = gain;
      if (s.noiseSuppressionMode === 'enhanced') {
        const node = await makeRnnoiseNode(ctx);
        if (mySeq !== this.seq) { try { await ctx.close(); } catch { /* ignore */ } return; } // superseded mid-await
        if (node) { node.connect(gain); head = node; }
      }
      src.connect(head);
      if (mySeq !== this.seq) { try { await ctx.close(); } catch { /* ignore */ } return; }
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = dest.stream;
      el.volume = Math.max(0, Math.min(1, s.masterVolume));
      const anyEl = el as unknown as { setSinkId?: (id: string) => Promise<void> };
      if (anyEl.setSinkId) anyEl.setSinkId(s.outputDeviceId || '').catch(() => { /* device gone — default */ });
      el.play().catch(() => { /* autoplay policy is permissive here; ignore */ });
      this.monitorCtx = ctx;
      this.monitorEl = el;
    } catch { /* monitoring is best-effort — the meter still works */ }
  }

  stop(): void {
    this.seq++;
    this.onEnded = null;
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.vad?.stop(); this.vad = null;
    if (this.monitorEl) { try { this.monitorEl.pause(); this.monitorEl.srcObject = null; } catch { /* ignore */ } this.monitorEl = null; }
    if (this.monitorCtx) { try { void this.monitorCtx.close(); } catch { /* ignore */ } this.monitorCtx = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
