/**
 * Guest voice mesh — same perfect-negotiation + polite split as room-voice.ts
 * (`selfId > peerId` is polite). Audio only: no RNNoise, no screenshare send.
 */

export type SignalKind = 'offer' | 'answer' | 'ice';

const MAX_VOICE_PEERS = 8;
const MAX_PENDING_ICE = 64;
const VAD_THRESHOLD = 14;
const VAD_HANGOVER_MS = 250;

export interface VoiceHooks {
  selfId: string;
  iceServers: RTCIceServer[];
  sendSignal(to: string, kind: SignalKind, data: unknown): void;
  announce(inVoice: boolean, muted: boolean, at: number, deafened?: boolean): void;
  onChange(): void;
}

class Vad {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  speaking = false;
  private lastLoud = 0;

  constructor(stream: MediaStream, private onSpeaking: (s: boolean) => void) {
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
        const now = Date.now();
        if (avg > VAD_THRESHOLD) this.lastLoud = now;
        const s = now - this.lastLoud < VAD_HANGOVER_MS;
        if (s !== this.speaking) { this.speaking = s; this.onSpeaking(s); }
      }, 100);
    } catch { /* speaking stays off */ }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
  }
}

class MediaPeer {
  private pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private audioEl: HTMLAudioElement | null = null;
  private vad: Vad | null = null;
  private closed = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private deafened = false;
  speaking = false;

  constructor(
    private id: string,
    private polite: boolean,
    private hooks: VoiceHooks,
    localStream: MediaStream,
    private onSpeaking: (s: boolean) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: hooks.iceServers });
    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.hooks.sendSignal(this.id, 'offer', this.pc.localDescription);
      } catch { /* ignore */ }
      finally { this.makingOffer = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.hooks.sendSignal(this.id, 'ice', candidate); };
    this.pc.ontrack = ({ track, streams }) => {
      if (track.kind !== 'audio') return;
      const stream = streams[0];
      if (!stream) return;
      if (!this.audioEl) { this.audioEl = new Audio(); this.audioEl.autoplay = true; }
      this.audioEl.srcObject = stream;
      this.audioEl.muted = this.deafened;
      void this.audioEl.play().catch(() => { /* gesture */ });
      this.vad?.stop();
      this.vad = new Vad(stream, (s) => { if (!this.closed) { this.speaking = s; this.onSpeaking(s); } });
    };
  }

  async onSignal(kind: SignalKind, data: unknown): Promise<void> {
    if (this.closed) return;
    try {
      if (kind === 'offer' || kind === 'answer') {
        const ready = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const collision = kind === 'offer' && !ready;
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        this.settingRemoteAnswer = kind === 'answer';
        await this.pc.setRemoteDescription(data as RTCSessionDescriptionInit);
        this.settingRemoteAnswer = false;
        const pend = this.pendingIce; this.pendingIce = [];
        for (const c of pend) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
        if (kind === 'offer') {
          await this.pc.setLocalDescription();
          this.hooks.sendSignal(this.id, 'answer', this.pc.localDescription);
        }
      } else if (kind === 'ice') {
        if (!this.pc.remoteDescription) {
          if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(data as RTCIceCandidateInit);
          return;
        }
        try { await this.pc.addIceCandidate(data as RTCIceCandidateInit); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  setDeafened(d: boolean): void {
    this.deafened = d;
    if (this.audioEl) this.audioEl.muted = d;
  }

  close(): void {
    this.closed = true;
    this.vad?.stop();
    try { this.pc.close(); } catch { /* ignore */ }
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null; }
  }
}

export interface VoiceParticipant {
  memberId: string;
  muted: boolean;
  deafened?: boolean;
  speaking: boolean;
}

export class GuestVoice {
  inVoice = false;
  muted = false;
  deafened = false;
  private stream: MediaStream | null = null;
  private peers = new Map<string, MediaPeer>();
  private roster = new Map<string, { muted: boolean; deafened: boolean }>();
  private speaking = new Set<string>();
  private lastAt = 0;
  private localSpeaking = false;
  private localVad: Vad | null = null;

  constructor(private hooks: VoiceHooks) {}

  private nextAt(): number {
    const n = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = n;
    return n;
  }

  participants(): VoiceParticipant[] {
    const out: VoiceParticipant[] = [];
    if (this.inVoice) {
      out.push({ memberId: this.hooks.selfId, muted: this.muted, deafened: this.deafened, speaking: this.localSpeaking && !this.muted });
    }
    for (const [id, st] of this.roster) {
      if (id === this.hooks.selfId) continue;
      out.push({
        memberId: id,
        muted: st.muted,
        deafened: st.deafened,
        speaking: this.speaking.has(id) && !st.muted,
      });
    }
    return out;
  }

  async join(): Promise<void> {
    if (this.inVoice) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-mic');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inVoice = true;
    this.localVad = new Vad(this.stream, (s) => {
      this.localSpeaking = s;
      this.hooks.onChange();
    });
    this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
    for (const id of this.roster.keys()) this.ensurePeer(id);
    this.hooks.onChange();
  }

  leave(): void {
    if (!this.inVoice) return;
    this.inVoice = false;
    this.localVad?.stop();
    this.localVad = null;
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.speaking.clear();
    this.localSpeaking = false;
    this.hooks.announce(false, false, this.nextAt(), false);
    this.hooks.onChange();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    const track = this.stream?.getAudioTracks()[0];
    if (track) track.enabled = !m && this.inVoice;
    if (this.inVoice) this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
    this.hooks.onChange();
  }

  setDeafened(d: boolean): void {
    this.deafened = d;
    for (const p of this.peers.values()) p.setDeafened(d);
    if (this.inVoice) this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
    this.hooks.onChange();
  }

  onPeerState(memberId: string, inVoice: boolean, muted: boolean, _at: number, deafened?: boolean): void {
    if (!inVoice) {
      this.roster.delete(memberId);
      this.peers.get(memberId)?.close();
      this.peers.delete(memberId);
      this.speaking.delete(memberId);
      this.hooks.onChange();
      return;
    }
    this.roster.set(memberId, { muted, deafened: deafened === true });
    if (this.inVoice) this.ensurePeer(memberId);
    this.hooks.onChange();
  }

  onSignal(from: string, kind: SignalKind, data: unknown): void {
    if (this.roster.has(from)) {
      void this.ensurePeer(from)?.onSignal(kind, data);
    }
  }

  onMemberGone(memberId: string): void {
    this.roster.delete(memberId);
    this.peers.get(memberId)?.close();
    this.peers.delete(memberId);
    this.speaking.delete(memberId);
    this.hooks.onChange();
  }

  private ensurePeer(memberId: string): MediaPeer | undefined {
    if (!this.inVoice || !this.stream || memberId === this.hooks.selfId) return;
    let p = this.peers.get(memberId);
    if (p) return p;
    if (this.peers.size >= MAX_VOICE_PEERS) return;
    const polite = this.hooks.selfId > memberId;
    p = new MediaPeer(memberId, polite, this.hooks, this.stream, (s) => {
      if (s) this.speaking.add(memberId); else this.speaking.delete(memberId);
      this.hooks.onChange();
    });
    this.peers.set(memberId, p);
    return p;
  }
}
