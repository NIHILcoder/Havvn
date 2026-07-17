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

import type { VoiceSettings } from '../../shared/types';

export type SignalKind = 'offer' | 'answer' | 'ice';

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
    noiseSuppression: true,
    autoGainControl: true,
  };
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
    noiseSuppression: r.noiseSuppression !== false,
    autoGainControl: r.autoGainControl !== false,
  };
}

/** The knobs that require a fresh getUserMedia (vs live-adjustable ones). */
function captureKey(s: VoiceSettings): string {
  return JSON.stringify([s.inputDeviceId, s.echoCancellation, s.noiseSuppression, s.autoGainControl]);
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
  announce(inVoice: boolean, muted: boolean, at: number): void;
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

export interface VoiceParticipant {
  memberId: string;
  muted: boolean;
  speaking: boolean;
  sharing: boolean;        // this member is sharing their screen
}

export interface VoiceState {
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
const MAX_VOICE_PEERS = 8;
const MAX_PENDING_ICE = 64;  // per-peer ICE buffer cap (real ICE is a few dozen) — bounds a flood-before-offer
// Anti-replay stamps (lastStateAt/lastShareAt) are kept across a member's departure
// so a captured old signed presence can't resurrect them — FIFO-capped so a member
// minting endless identities can't grow the maps without bound.
const MAX_ANTIREPLAY = 512;

/** Evict oldest (front) entries until the map is under `max`. Insertion order = age
 *  (callers re-insert on refresh), so the front is the least-recently-stamped. */
function capMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size >= max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

// Screenshare quality caps. The mesh leg is real upstream bandwidth (per watching
// viewer); the loopback leg is host-local, so its cap only bounds encoder CPU.
const SHARE_MESH_MAX_BITRATE = 2_500_000;
const SHARE_LOOPBACK_MAX_BITRATE = 10_000_000;
const SHARE_MAX_FRAMERATE = 15;

/** Best-effort sender bitrate/framerate cap (screen video legs). */
async function applyShareCaps(sender: RTCRtpSender, maxBitrate: number): Promise<void> {
  try {
    const p = sender.getParameters();                       // reuse — carries transactionId
    (p as any).degradationPreference = 'maintain-resolution'; // pairs with contentHint 'detail' (text stays sharp)
    if (!p.encodings?.length) p.encodings = [{} as RTCRtpEncodingParameters];
    p.encodings[0].maxBitrate = maxBitrate;
    (p.encodings[0] as any).maxFramerate = SHARE_MAX_FRAMERATE;
    await sender.setParameters(p);
  } catch { /* caps are best-effort */ }
}

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
  private sinkId = '';  // desired output device ('' = system default); applied when audioEl exists
  private deafened = false;                        // WE are deafened (mutes every peer's output)
  private locallyMuted = false;                    // this member is locally muted on THIS install (output cut, PC kept)
  private shareTransceiver: RTCRtpTransceiver | null = null; // OUR outgoing screen transceiver (sendonly)
  private watching = false;                        // we want THEIR screen video (recv gating)
  volume = 1;           // EFFECTIVE volume (master × per-user) — the session computes it

  constructor(
    private id: string,
    private polite: boolean,
    private a: VoiceAdapter,
    localStream: MediaStream,
    private onSpeaking: (s: boolean) => void,
    private onRemoteShare: (track: MediaStreamTrack | null, stream: MediaStream | null) => void,
    private onFailed: () => void,
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
    // A PC can go dead asymmetrically (our side torn down while the peer kept
    // theirs — the fresh PC then can't complete against their stale one, so its
    // DTLS/ICE ultimately fails). Reap it so the session re-creates a clean pair.
    this.pc.onconnectionstatechange = () => {
      if (!this.closed && (this.pc.connectionState === 'failed')) this.onFailed();
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.a.sendSignal(this.id, 'ice', candidate); };
    this.pc.ontrack = ({ track, streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (track.kind === 'video') {
        // Screen path: no Audio element, no VAD. Hand the track up — the session
        // attaches it to a loopback forwarder if (or when) the user watches.
        track.onended = () => { if (!this.closed) this.onRemoteShare(null, null); };
        this.onRemoteShare(track, stream);
        return;
      }
      if (!this.audioEl) { this.audioEl = new Audio(); this.audioEl.autoplay = true; }
      this.audioEl.srcObject = stream;
      this.audioEl.volume = this.volume;
      this.applyOutputMute(); // honor a deafen / local-mute set before the track arrived
      this.applySink();
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
          // Answer remote video m-lines per our watch state BEFORE the implicit
          // answer: 'inactive' unless watching, so a share we don't view costs the
          // sharer no bandwidth. Idempotent — re-applied on every offer, which also
          // self-heals a direction flip lost to a glare rollback.
          this.applyRecvPolicy();
          await this.pc.setLocalDescription();
          this.a.sendSignal(this.id, 'answer', this.pc.localDescription);
          return;
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
    if (this.audioEl) this.audioEl.muted = this.deafened || this.locallyMuted;
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
  replaceAudioTrack(track: MediaStreamTrack): void {
    if (this.closed) return;
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind === 'audio') void sender.replaceTrack(track).catch(() => { /* ignore */ });
    }
  }

  /** Start sending our screen track to this peer (fires negotiationneeded →
   *  perfect-negotiation renegotiates). Uses addTransceiver, NOT addTrack: addTrack
   *  RECYCLES the first free same-kind transceiver — which, when the peer is already
   *  sharing, is the very m-line RECEIVING their screen. Recycling it (then forcing
   *  'sendonly') would kill both shares on this leg. addTransceiver always makes a
   *  fresh m-line, leaving their incoming share untouched. */
  addShareTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.closed || this.shareTransceiver) return;
    this.shareTransceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    void applyShareCaps(this.shareTransceiver.sender, SHARE_MESH_MAX_BITRATE);
  }

  /** Stop sending our screen track. transceiver.stop() (not removeTrack) marks the
   *  m-line closed (port 0) so its slot can be recycled by a later addTransceiver —
   *  removeTrack alone would leak a dead m-line per stop/re-share cycle. */
  removeShareTrack(): void {
    if (!this.shareTransceiver) return;
    try { this.shareTransceiver.stop(); } catch { /* stop() may be unsupported mid-negotiation */ }
    this.shareTransceiver = null;
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

  close(): void {
    this.closed = true;
    this.vad?.stop(); this.vad = null;
    try { this.pc.close(); } catch { /* ignore */ }
    if (this.audioEl) { try { this.audioEl.srcObject = null; } catch { /* ignore */ } this.audioEl = null; }
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
  private joining = false; // getUserMedia in flight (re-entrancy guard)
  private muted = false;
  private deafened = false;
  private mutedBeforeDeafen = false; // restore this exact mute state on un-deafen
  private inputMode: VoiceInputMode = 'always';
  private pttActive = false;         // is the push-to-talk key held right now
  private vadOpen = false;           // local VAD currently detecting speech
  private localStream: MediaStream | null = null; // PROCESSED (post-gain) stream — its track is sent to peers, gated
  private rawStream: MediaStream | null = null;   // physical mic capture feeding the pipeline (pre-gain)
  private audioCtx: AudioContext | null = null;   // capture pipeline: source → gain → destination
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
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
  private roster = new Map<string, { muted: boolean }>();     // OTHER members currently in voice
  private speaking = new Map<string, boolean>();              // memberId → speaking (remote)
  private volumes = new Map<string, number>();                // memberId → 0..1
  private lastStateAt = new Map<string, number>();            // memberId → last accepted voice-state timestamp (anti-replay)
  private announceAt = 0;                                      // strictly-monotonic stamp for OUR announcements
  private pendingOffers = new Map<string, unknown>();          // authenticated offer that arrived before its sender's presence (relay reorder), applied on roster (capped)
  // ── Screenshare ──
  private shareStream: MediaStream | null = null;              // OUR screen capture (engine-window getUserMedia desktop)
  private shareTrack: MediaStreamTrack | null = null;
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

  isActive(): boolean { return this.active; }

  /** Capture the configured mic. If the chosen device is gone, falls back to the
   *  system default WITHOUT clearing the preference (it may come back) and returns
   *  the fallback in `warning` for the UI to toast. */
  private async captureMic(s: VoiceSettings): Promise<{ stream: MediaStream; warning?: string }> {
    const base = {
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
    };
    if (s.inputDeviceId) {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: s.inputDeviceId } } }) };
      } catch { /* chosen mic unplugged/unavailable — fall through to default */ }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    return { stream, warning: s.inputDeviceId ? 'Selected microphone is unavailable — using the system default.' : undefined };
  }

  /** Build (or rebuild) the capture pipeline: raw mic → gain → sent stream. On Web
   *  Audio failure the raw stream is sent directly (gain then has no effect). */
  private buildPipeline(raw: MediaStream, s: VoiceSettings): MediaStream {
    try {
      this.audioCtx = new AudioContext();
      void this.audioCtx.resume().catch(() => { /* ignore */ });
      this.srcNode = this.audioCtx.createMediaStreamSource(raw);
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = s.inputGain;
      const dest = this.audioCtx.createMediaStreamDestination();
      this.srcNode.connect(this.gainNode);
      this.gainNode.connect(dest);
      return dest.stream;
    } catch {
      this.audioCtx = null; this.srcNode = null; this.gainNode = null;
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
    this.joining = true;
    let warning: string | undefined;
    try {
      const cap = await this.captureMic(s);
      this.rawStream = cap.stream;
      warning = cap.warning;
    } finally { this.joining = false; }
    this.curCaptureKey = captureKey(s);
    this.usingFallback = !!warning;
    this.watchRawTrack(); // a mid-call unplug ends the track — recapture instead of going silent
    this.masterVolume = s.masterVolume;
    this.localStream = this.buildPipeline(this.rawStream, s);
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
    this.a.announce(true, this.muted, this.nextAt());
    for (const id of this.roster.keys()) this.ensurePeer(id); // connect to everyone already here
    this.a.onChange();
    // Settings may have changed while getUserMedia was in flight (the engine's
    // room-cmd handler is not serialized across awaits). Reconcile BOTH the live
    // knobs (gain/volume/VAD — built above from the pre-await snapshot) and the
    // capture config against the latest settings.
    this.applySettings();
    return warning;
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    // Screenshare teardown FIRST: release the capture before closing PCs, close
    // every open watch ('end' → the renderer overlay closes), drop share state.
    // No separate announceShare(false) — receivers clear sharing on inVoice:false.
    this.shareStream?.getTracks().forEach((t) => t.stop());
    this.shareStream = null; this.shareTrack = null;
    for (const f of this.forwarders.values()) f.close(true);
    this.forwarders.clear();
    this.remoteTracks.clear();
    this.remoteShares.clear();
    this.pendingShares.clear();
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
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
    this.srcNode = null; this.gainNode = null;
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    this.audioCtx = null;
    this.curCaptureKey = '';
    this.localSpeaking = false;
    this.vadOpen = false;
    this.pttActive = false;
    this.speaking.clear();
    this.pendingOffers.clear();
    this.a.announce(false, false, this.nextAt());
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
      this.curCaptureKey = ''; // force recaptureIfNeeded past its equality guard
      this.settingsChain = this.settingsChain.then(() => this.recaptureIfNeeded()).catch(() => { /* ignore */ });
    };
  }

  /** An audio device came or went (engine 'devicechange'). Retry capture if we're
   *  on the fallback default (the preferred device may have returned) OR capture is
   *  broken entirely (the only input was unplugged — a returning device recovers us). */
  onDevicesChanged(): void {
    if (!this.active) return;
    if (this.captureBroken || (this.usingFallback && this.getSettings().inputDeviceId)) {
      this.curCaptureKey = '';
      this.settingsChain = this.settingsChain.then(() => this.recaptureIfNeeded()).catch(() => { /* ignore */ });
    }
  }

  /** Swap the mic feeding the pipeline if the requested capture config drifted
   *  from what we captured with. Keyed on the REQUESTED config (not the actual
   *  device used), so an unavailable-device fallback doesn't retry forever. */
  private async recaptureIfNeeded(): Promise<void> {
    if (!this.active) return;
    const s = this.getSettings();
    const key = captureKey(s);
    if (key === this.curCaptureKey) return;
    let cap: { stream: MediaStream; warning?: string };
    // A total capture failure (no device at all) leaves us silent — flag it so a
    // later devicechange retries (usingFallback wouldn't latch, blocking recovery).
    try { cap = await this.captureMic(s); }
    catch (e) { this.a.log('voice recapture failed: ' + String(e)); this.captureBroken = true; return; }
    const fresh = cap.stream;
    if (!this.active) { fresh.getTracks().forEach((t) => t.stop()); return; } // left voice mid-recapture
    this.captureBroken = false;
    this.curCaptureKey = key;
    const wasFallback = this.usingFallback;
    this.usingFallback = !!cap.warning;
    if (cap.warning && !wasFallback) this.a.warn(cap.warning); // loud at join, now loud mid-call too
    const old = this.rawStream;
    this.rawStream = fresh;
    this.watchRawTrack();
    if (this.audioCtx && this.gainNode) {
      try { this.srcNode?.disconnect(); } catch { /* ignore */ }
      this.srcNode = this.audioCtx.createMediaStreamSource(fresh);
      this.srcNode.connect(this.gainNode);
    } else {
      // No-pipeline fallback (Web Audio failed at join): the raw track IS the sent
      // track — swap it on every live sender and rebuild the VAD on the new track.
      const track = fresh.getAudioTracks()[0];
      if (track) {
        this.localStream = fresh;
        for (const p of this.peers.values()) p.replaceAudioTrack(track);
        this.localVad?.stop();
        this.vadStream?.getTracks().forEach((t) => t.stop());
        const clone = track.clone();
        this.vadStream = clone ? new MediaStream([clone]) : null;
        this.localVad = this.vadStream ? new Vad(this.vadStream, (vs) => this.onVad(vs), this.now, s.vadThreshold) : null;
        this.applyTransmit();
      }
    }
    old?.getTracks().forEach((t) => t.stop());
  }

  private effectiveVolume(memberId: string): number {
    return this.masterVolume * (this.volumes.get(memberId) ?? 1);
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
    this.peers.get(memberId)?.setVolume(this.effectiveVolume(memberId));
  }

  /** Locally mute (ignore) a member: silence their audio without tearing the media
   *  connection down. `memberId==null` re-applies the whole set (after ensurePeer
   *  rebuilds a peer). */
  setLocallyMuted(muted: Set<string>): void {
    this.locallyMutedIds = muted;
    for (const [id, p] of this.peers) p.setLocallyMuted(muted.has(id));
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
  }

  stopShare(): void {
    if (!this.shareStream) return;
    for (const p of this.peers.values()) p.removeShareTrack(); // → renegotiate
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
    if (!Number.isFinite(at) || at <= (this.lastShareAt.get(memberId) ?? 0)) return; // stale/replayed — drop
    this.lastShareAt.delete(memberId); this.lastShareAt.set(memberId, at); // re-insert at tail (freshest)
    capMap(this.lastShareAt, MAX_ANTIREPLAY);
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
    } else {
      this.remoteShares.delete(memberId);
      this.remoteTracks.delete(memberId);
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
    this.lastStateAt.delete(memberId); this.lastStateAt.set(memberId, at); // re-insert at tail (freshest)
    capMap(this.lastStateAt, MAX_ANTIREPLAY);
    const had = this.roster.has(memberId);
    if (inVoice) {
      // Cap: don't let unlimited (possibly fabricated) identities grow the roster.
      if (!had && this.roster.size >= MAX_VOICE_PEERS) { this.a.log('voice roster full — ignoring ' + memberId.slice(0, 8)); return; }
      this.roster.set(memberId, { muted });
      // A voice-share that beat this voice-state (unordered flood) applies now.
      const pend = this.pendingShares.get(memberId);
      if (pend) { this.pendingShares.delete(memberId); this.applyPeerShare(memberId, true, pend.streamId); }
    } else {
      this.roster.delete(memberId); this.speaking.delete(memberId);
      // Leaving voice implies their share ended (no separate announce is sent).
      this.pendingShares.delete(memberId);
      if (this.remoteShares.has(memberId)) this.applyPeerShare(memberId, false, '');
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

  /** A member left the ROOM entirely — drop them from voice too. NOTE: the
   *  anti-replay stamps (lastStateAt/lastShareAt) are deliberately KEPT — deleting
   *  them re-opens a replay window (a captured old signed inVoice/sharing:true would
   *  verify against a cleared floor and resurrect a ghost). They're monotonic
   *  floors, so a legitimate later re-announce (higher `at`) still passes; only a
   *  stale replay is blocked. FIFO-capped so minted identities can't grow them. */
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
    this.a.onChange();
  }

  /** Re-broadcast our presence (call when a NEW member appears, so a late joiner
   *  learns we're already in voice — presence is only gossiped on change). Always
   *  emits the CURRENT share truth (including sharing:false) so any hello corrects a
   *  member whose LIVE badge was set by a replayed voice-share. */
  reannounce(): void {
    if (!this.active) return;
    this.a.announce(true, this.muted, this.nextAt());
    this.a.announceShare(this.isSharing(), this.shareStream?.id || '', this.nextAt());
  }

  /** VPN kill-switch / room teardown: fully stop voice (releases the mic). */
  suspend(): void { this.leave(); }

  private ensurePeer(memberId: string): MediaPeer | undefined {
    let p = this.peers.get(memberId);
    if (!p && this.localStream) {
      if (this.peers.size >= MAX_VOICE_PEERS) { this.a.log('voice peer cap reached — not connecting ' + memberId.slice(0, 8)); return undefined; }
      // Deterministic polite/impolite split by id so exactly one side wins glare.
      const polite = this.a.selfId > memberId;
      p = new MediaPeer(
        memberId, polite, this.a, this.localStream,
        (s) => this.setSpeaking(memberId, s),
        (track, stream) => this.setRemoteShareTrack(memberId, track, stream),
        () => this.onPeerFailed(memberId),
        this.now,
      );
      p.setSink(this.getSettings().outputDeviceId || '');
      p.setVolume(this.effectiveVolume(memberId));
      if (this.deafened) p.setDeafened(true);
      if (this.locallyMutedIds.has(memberId)) p.setLocallyMuted(true);
      // Mid-share join: attach the live screen track BEFORE the pending offer is
      // applied, so the fresh (stable) PC carries it in its very first negotiation.
      if (this.shareTrack && this.shareStream) p.addShareTrack(this.shareTrack, this.shareStream);
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

  /** A peer's RTCPeerConnection reached 'failed' (e.g. it was torn down on our side
   *  while the remote kept theirs, so the fresh PC couldn't complete). Drop it and,
   *  if the member is still rostered, re-create a clean pair. */
  private onPeerFailed(memberId: string): void {
    if (!this.active) return;
    this.dropPeer(memberId);
    if (!this.roster.has(memberId)) return;
    const p = this.ensurePeer(memberId);
    // If we were watching this member's screen, the rebuilt peer starts with
    // watching=false — re-arm it so the video m-line renegotiates back to recvonly.
    if (p && this.forwarders.has(memberId)) p.setWatching(true);
  }

  private setSpeaking(memberId: string, s: boolean): void {
    if ((this.speaking.get(memberId) ?? false) === s) return;
    this.speaking.set(memberId, s);
    this.a.onChange();
  }

  getState(): VoiceState {
    const participants: VoiceParticipant[] = [];
    if (this.active) participants.push({ memberId: this.a.selfId, muted: this.muted, speaking: this.localSpeaking && !this.muted, sharing: this.isSharing() });
    for (const [id, st] of this.roster) {
      participants.push({ memberId: id, muted: st.muted, speaking: !!this.speaking.get(id) && !st.muted, sharing: this.remoteShares.has(id) });
    }
    return { inVoice: this.active, muted: this.muted, deafened: this.deafened, transmitting: this.transmitting(), inputMode: this.inputMode, sharing: this.isSharing(), participants };
  }
}

// Mic test auto-stop: don't hold the mic forever if the renderer dies with the
// settings modal open (its stop() would never arrive).
const MIC_TEST_MAX_MS = 60_000;

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

  /** `onEnded` fires when the test stops ON ITS OWN (the 60s deadline) so the UI can
   *  drop out of its "testing" state — an explicit stop() is caller-driven and does
   *  NOT fire it. */
  async start(s: VoiceSettings, onLevel: (level: number) => void, onEnded?: () => void): Promise<void> {
    this.stop(); // also bumps seq, invalidating any in-flight start
    const mySeq = ++this.seq;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone unavailable (the room engine is not a secure context).');
    }
    const base = { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl };
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
    this.stopTimer = setTimeout(() => { const cb = this.onEnded; this.stop(); cb?.(); }, MIC_TEST_MAX_MS);
  }

  stop(): void {
    this.seq++;
    this.onEnded = null;
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.vad?.stop(); this.vad = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
