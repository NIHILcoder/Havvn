/**
 * Guest voice mesh — same perfect-negotiation + polite split as room-voice.ts
 * (`selfId > peerId` is polite). Audio only: no RNNoise, no screenshare send.
 */

import { VoiceLinkRecovery, type VoiceLinkState } from '../shared/room-voice-recovery';
import { acceptVoiceStamp, ROOM_VOICE_PEERS, ROOM_VOICE_ROSTER, voiceMeshMembers } from '../shared/room-voice-policy';

export type SignalKind = 'offer' | 'answer' | 'ice';

const MAX_VOICE_PEERS = ROOM_VOICE_PEERS;
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

  resume(): void { try { void this.ctx?.resume().catch(() => {}); } catch { /* unavailable context */ } }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
  }
}

class MediaPeer {
  private pc: RTCPeerConnection;
  readonly recovery: VoiceLinkRecovery;
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
    this.recovery = new VoiceLinkRecovery(() => this.pc.restartIce(), () => hooks.onChange(), () => Date.now(), () => this.pc.connectionState, () => Math.floor(Math.random() * 250));
    this.pc.onconnectionstatechange = () => { if (!this.closed) this.recovery.update(this.pc.connectionState); };
    this.pc.oniceconnectionstatechange = this.pc.onconnectionstatechange;
    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (!this.closed) this.hooks.sendSignal(this.id, 'offer', this.pc.localDescription);
      } catch { /* ignore */ }
      finally { this.makingOffer = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (!this.closed && candidate) this.hooks.sendSignal(this.id, 'ice', candidate); };
    this.pc.ontrack = ({ track, streams }) => {
      if (this.closed) return;
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
        try { await this.pc.setRemoteDescription(data as RTCSessionDescriptionInit);
        } finally { this.settingRemoteAnswer = false; }
        if (this.closed) return;
        this.settingRemoteAnswer = false;
        const pend = this.pendingIce; this.pendingIce = [];
        for (const c of pend) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
        if (kind === 'offer') {
          await this.pc.setLocalDescription();
          if (!this.closed) this.hooks.sendSignal(this.id, 'answer', this.pc.localDescription);
        }
      } else if (kind === 'ice') {
        if (!this.pc.remoteDescription) {
          if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(data as RTCIceCandidateInit);
          return;
        }
        try { await this.pc.addIceCandidate(data as RTCIceCandidateInit); } catch { /* ignore */ }
      }
    } catch { /* ignore */ } finally {
      if (!this.closed && this.pc.signalingState === 'stable' && this.pc.connectionState === 'connected') this.recovery.update('connected');
    }
  }

  resume(): void {
    if (this.closed) return;
    this.vad?.resume();
    void this.audioEl?.play().catch(() => {});
  }

  replaceAudioTrack(track: MediaStreamTrack): void {
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind === 'audio') void sender.replaceTrack(track).catch(() => { this.recovery.update('failed'); });
    }
  }

  setDeafened(d: boolean): void {
    this.deafened = d;
    if (this.audioEl) this.audioEl.muted = d;
  }

  close(): void {
    this.closed = true;
    this.recovery.close();
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
  connection?: VoiceLinkState;
  reconnectAttempts?: number;
  waitingForSlot?: boolean;
}

export class GuestVoice {
  inVoice = false;
  muted = false;
  deafened = false;
  micUnavailable = false;
  private recapturing = false;
  private recaptureAgain = false;
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly online = () => this.onNetworkChanged();
  private readonly devices = () => this.onDevicesChanged();
  private joining = false;
  private captureGeneration = 0;
  private stream: MediaStream | null = null;
  private peers = new Map<string, MediaPeer>();
  private roster = new Map<string, { muted: boolean; deafened: boolean }>();
  private speaking = new Set<string>();
  private lastAt = 0;
  private lastStateAt = new Map<string, number>();
  private pendingOffers = new Map<string, unknown>();
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
    const admitted = this.meshMembers();
    if (this.inVoice) {
      out.push({ memberId: this.hooks.selfId, ...(!admitted.has(this.hooks.selfId) ? { waitingForSlot: true } : {}), muted: this.muted, deafened: this.deafened, speaking: this.localSpeaking && !this.muted });
    }
    for (const [id, st] of this.roster) {
      if (id === this.hooks.selfId) continue;
      out.push({
        memberId: id,
        ...(!admitted.has(id) ? { waitingForSlot: true } : {}),
        muted: st.muted,
        deafened: st.deafened,
        speaking: this.speaking.has(id) && !st.muted,
        ...(this.inVoice && this.peers.has(id) ? { connection: this.peers.get(id)!.recovery.state, reconnectAttempts: this.peers.get(id)!.recovery.attempts } : {}),
      });
    }
    return out;
  }

  async join(): Promise<void> {
    if (this.inVoice || this.joining) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-mic');
    const generation = ++this.captureGeneration;
    this.joining = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (generation !== this.captureGeneration) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.inVoice = true;
      this.micUnavailable = false;
      this.watchMicrophone();
      globalThis.addEventListener?.('online', this.online);
      navigator.mediaDevices.addEventListener?.('devicechange', this.devices);
      this.applyTransmit();
      this.localVad = new Vad(this.stream, (s) => {
        this.localSpeaking = s;
        this.hooks.onChange();
      });
      this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
      this.reconcilePeers();
      this.hooks.onChange();
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
    const wasActive = this.inVoice, wasJoining = this.joining;
    this.joining = false;
    globalThis.removeEventListener?.('online', this.online);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.devices);
    if (this.deviceTimer) { clearTimeout(this.deviceTimer); this.deviceTimer = null; }
    this.micUnavailable = false;
    this.recapturing = false; this.recaptureAgain = false;
    if (!wasActive && !wasJoining) return;
    this.inVoice = false;
    this.localVad?.stop();
    this.localVad = null;
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.speaking.clear(); this.pendingOffers.clear();
    this.localSpeaking = false;
    if (wasActive) this.hooks.announce(false, false, this.nextAt(), false);
    this.hooks.onChange();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyTransmit();
    if (this.inVoice) this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
    this.hooks.onChange();
  }

  setDeafened(d: boolean): void {
    this.deafened = d;
    this.applyTransmit();
    for (const p of this.peers.values()) p.setDeafened(d);
    if (this.inVoice) this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
    this.hooks.onChange();
  }

  reconnect(): void {
    if (!this.inVoice) return;
    for (const p of this.peers.values()) { p.resume(); p.recovery.retry(); }
    this.localVad?.resume();
    if (this.micUnavailable) void this.recapture();
    this.reannounce();
  }

  onNetworkChanged(): void {
    if (!this.inVoice) return;
    for (const p of this.peers.values()) { p.resume(); p.recovery.networkChanged(); }
    this.localVad?.resume();
    this.reannounce();
  }

  onDevicesChanged(): void {
    if (!this.inVoice || this.deviceTimer) return;
    this.deviceTimer = setTimeout(() => { this.deviceTimer = null; if (this.recapturing) this.recaptureAgain = true; else void this.recapture(); }, 300);
  }

  private watchMicrophone(): void {
    const track = this.stream?.getAudioTracks()[0];
    if (track) track.onended = () => {
      if (!this.inVoice || this.stream?.getAudioTracks()[0] !== track) return;
      this.micUnavailable = true; this.localSpeaking = false; this.hooks.onChange();
      void this.recapture();
    };
  }

  private async recapture(): Promise<void> {
    if (!this.inVoice || this.recapturing) return;
    const generation = this.captureGeneration;
    this.recapturing = true;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!this.inVoice || generation !== this.captureGeneration) { fresh.getTracks().forEach(t => t.stop()); return; }
      // Gate BEFORE sender replacement; preserve mute and deafen during hotplug.
      fresh.getAudioTracks().forEach(t => { t.enabled = !this.muted && !this.deafened; });
      const old = this.stream; this.stream = fresh;
      this.watchMicrophone();
      this.localVad?.stop();
      this.localVad = new Vad(fresh, s => { this.localSpeaking = s; this.hooks.onChange(); });
      this.localSpeaking = false; this.micUnavailable = false;
      for (const p of this.peers.values()) p.replaceAudioTrack(fresh.getAudioTracks()[0]);
      old?.getTracks().forEach(t => t.stop());
      this.hooks.onChange();
    } catch {
      if (generation === this.captureGeneration) {
        this.micUnavailable = this.stream?.getAudioTracks()[0]?.readyState === 'ended';
        this.hooks.onChange();
      }
    } finally {
      if (generation === this.captureGeneration) {
        this.recapturing = false;
        if (this.recaptureAgain) { this.recaptureAgain = false; this.onDevicesChanged(); }
      }
    }
  }

  private applyTransmit(): void {
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = this.inVoice && this.meshMembers().has(this.hooks.selfId) && !this.muted && !this.deafened; });
  }

  onPeerState(memberId: string, inVoice: boolean, muted: boolean, at: number, deafened?: boolean): void {
    if (memberId === this.hooks.selfId || !acceptVoiceStamp(this.lastStateAt, memberId, at)) return;
    if (!inVoice) {
      this.pendingOffers.delete(memberId);
      this.roster.delete(memberId);
      this.peers.get(memberId)?.close();
      this.peers.delete(memberId);
      this.speaking.delete(memberId);
      this.reconcilePeers();
      this.hooks.onChange();
      return;
    }
    if (!this.roster.has(memberId) && this.roster.size >= ROOM_VOICE_ROSTER) return;
    this.roster.set(memberId, { muted, deafened: deafened === true });
    this.reconcilePeers();
    this.hooks.onChange();
  }

  onSignal(from: string, kind: SignalKind, data: unknown): void {
    if (!this.inVoice || from === this.hooks.selfId) return;
    if (this.roster.has(from)) { void this.ensurePeer(from)?.onSignal(kind, data); return; }
    // One authenticated offer per known room member while presence catches up.
    if (kind === 'offer' && (this.pendingOffers.has(from) || this.pendingOffers.size < MAX_VOICE_PEERS)) this.pendingOffers.set(from, data);
  }

  reannounce(): void {
    if (this.inVoice) this.hooks.announce(true, this.muted, this.nextAt(), this.deafened);
  }

  onMemberGone(memberId: string): void {
    this.pendingOffers.delete(memberId);
    this.roster.delete(memberId);
    this.peers.get(memberId)?.close();
    this.peers.delete(memberId);
    this.speaking.delete(memberId);
    this.reconcilePeers();
    this.hooks.onChange();
  }

  private meshMembers(): Set<string> { return voiceMeshMembers(this.hooks.selfId, this.inVoice, this.roster.keys()); }

  private reconcilePeers(): void {
    const admitted = this.meshMembers();
    for (const [id, peer] of this.peers) {
      if (!this.inVoice || !admitted.has(this.hooks.selfId) || !admitted.has(id)) { peer.close(); this.peers.delete(id); this.speaking.delete(id); }
    }
    if (this.inVoice && admitted.has(this.hooks.selfId)) for (const id of admitted) {
      if (id !== this.hooks.selfId) this.ensurePeer(id);
    }
    this.applyTransmit();
  }

  private ensurePeer(memberId: string): MediaPeer | undefined {
    const admitted = this.meshMembers();
    if (!this.inVoice || !admitted.has(this.hooks.selfId) || !admitted.has(memberId)) return;
    if (!this.inVoice || !this.stream || memberId === this.hooks.selfId) return;
    let p = this.peers.get(memberId);
    if (p) return p;
    if (this.peers.size >= MAX_VOICE_PEERS) return;
    const polite = this.hooks.selfId > memberId;
    p = new MediaPeer(memberId, polite, this.hooks, this.stream, (s) => {
      if (s) this.speaking.add(memberId); else this.speaking.delete(memberId);
      this.reconcilePeers();
      this.hooks.onChange();
    });
    p.setDeafened(this.deafened);
    this.peers.set(memberId, p);
    const offer = this.pendingOffers.get(memberId);
    if (offer !== undefined) { this.pendingOffers.delete(memberId); void p.onSignal('offer', offer); }
    return p;
  }
}
