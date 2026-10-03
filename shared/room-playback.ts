import { WatchReceiver, type WatchInput, type WatchPlaybackEvent } from './room-watch-sync';
import { playbackPhase, type PlaybackPhase } from './playback-buffer';
import { WATCH_CONTROLS, type WatchControl } from './room-watch-host';

export const WATCH_TRANSIT_MAX_MS = 2000;
export const WATCH_OPERATION_TIMEOUT_MS = 10_000;
const SOFT_DRIFT = 0.2, HARD_DRIFT = 1.8;

export interface PlaybackMedia {
  currentTime: number; playbackRate: number; paused: boolean;
  duration: number; readyState: number; seeking: boolean;
  play(): Promise<void>; pause(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
interface Sample { event: WatchPlaybackEvent; receivedAt: number }
interface Operation {
  position: number; rate: number; playing: boolean; seek: boolean; play: boolean;
  deadline?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout>;
}

/** Buffer starvation and seeking do not represent a deliberate pause. */
export function observeWatchPlayback(media: HTMLMediaElement, report: (phase: PlaybackPhase) => void): () => void {
  let waiting = media.readyState < 3;
  const sync = () => report(playbackPhase({ attached: true, readyState: media.readyState, paused: media.paused,
    ended: media.ended, seeking: media.seeking, waiting, errorCode: media.error?.code }, null, false, false));
  const blocked = () => { waiting = true; sync(); }, ready = () => { waiting = false; sync(); };
  const events = ['play', 'pause', 'seeking', 'seeked', 'ended', 'error', 'loadedmetadata', 'emptied'];
  for (const type of events) media.addEventListener(type, sync);
  media.addEventListener('waiting', blocked); media.addEventListener('stalled', blocked);
  media.addEventListener('playing', ready); media.addEventListener('canplay', ready);
  sync();
  return () => {
    for (const type of events) media.removeEventListener(type, sync);
    media.removeEventListener('waiting', blocked); media.removeEventListener('stalled', blocked);
    media.removeEventListener('playing', ready); media.removeEventListener('canplay', ready);
  };
}

/** Sender clocks are only an estimate. Local loading time is measured separately. */
export function watchPosition(event: Pick<WatchPlaybackEvent, 'position' | 'rate' | 'playing' | 'action' | 'at'>,
  receivedAt: number, now = receivedAt): number {
  const playing = event.action === 'play' || event.action !== 'pause' && event.playing;
  const elapsed = Math.min(WATCH_TRANSIT_MAX_MS, Math.max(0, receivedAt - event.at)) + Math.max(0, now - receivedAt);
  return event.position + (playing ? elapsed / 1000 * event.rate : 0);
}

/** Only one converged viewer advances the audio queue automatically. */
export function watchQueueDriver(selfId: string, viewers: Iterable<{ memberId: string; together: boolean; lastSeen: number }>, now = Date.now()): string {
  return [selfId, ...[...viewers].filter(v => v.together && now - v.lastSeen < 16_000).map(v => v.memberId)].sort()[0];
}

/** Shared media lifecycle, drift correction and echo suppression. One pending state. */
export class RoomPlaybackController {
  private receiver = new WatchReceiver();
  private media: PlaybackMedia | null = null;
  private detach: (() => void) | null = null;
  private fileId = '';
  private enabled = false;
  private ready = false;
  private localIntent = false;
  private initial = { position: 0, playing: true };
  private pending: Sample | null = null;
  private operation: Operation | null = null;
  private lateSeek: number | null = null;
  private rateEcho: number | null = null;
  private nudge: ReturnType<typeof setTimeout> | undefined;
  private baseRate = 1;
  private hostId = '';
  private selfId = '';
  private hostStamp = '';
  private shared: Sample | null = null;
  constructor(private now = () => Date.now()) {}

  get rate(): number { return this.baseRate; }
  get applying(): boolean { return !!this.operation || !this.ready; }
  get followingHost(): boolean { return this.enabled && !!this.hostId && this.hostId !== this.selfId; }
  setHost(hostId: string, selfId: string, stamp = ''): void {
    this.selfId = selfId;
    if (this.hostId === hostId && this.hostStamp === stamp) return;
    this.hostId = hostId; this.hostStamp = stamp;
    this.pending = null; this.shared = null; this.cancelOperation(); this.restoreRate(); this.localIntent = false;
  }
  suspend(): void { this.ready = false; this.cancelOperation(); this.restoreRate(); }
  setTogether(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.localIntent = false;
    else { this.pending = null; this.shared = null; this.cancelOperation(); this.restoreRate(); }
  }
  snapshot(action: string): WatchInput {
    return { fileId: this.fileId, action, position: this.ready ? this.media?.currentTime || 0 : this.initial.position,
      rate: this.baseRate, playing: this.ready ? !this.media?.paused : false, together: this.enabled };
  }
  chooseSource(fileId: string): void {
    this.pending = null;
    if (this.fileId === fileId && this.media && this.ready) {
      this.localIntent = false;
      this.applyState(0, this.baseRate, true, true);
    } else this.beginSource(fileId);
  }
  beginSource(fileId: string, resume?: { position: number; playing: boolean; rate?: number }): void {
    this.cancelOperation(); this.restoreRate(); this.lateSeek = null;
    if (this.fileId !== fileId) this.localIntent = false;
    if (resume && !resume.playing) this.localIntent = true;
    this.fileId = fileId; this.ready = false;
    this.initial = resume || { position: 0, playing: !this.followingHost };
    if (resume?.rate) this.baseRate = resume.rate;
    if (this.pending?.event.fileId !== fileId) this.pending = null;
  }
  attach(media: PlaybackMedia, emit: (input: WatchInput) => void): () => void {
    this.detach?.(); this.media = media;
    const listeners = new Map<string, EventListener>();
    const listen = (type: string, fn: () => void) => { listeners.set(type, fn); media.addEventListener(type, fn); };
    listen('loadedmetadata', () => {
      if (this.ready) return;
      this.ready = true;
      const sample = this.pending; this.pending = null;
      if (sample && this.enabled) this.apply(sample, true);
      else this.applyState(this.initial.position, this.baseRate, this.initial.playing, true);
    });
    listen('emptied', () => { this.ready = false; this.cancelOperation(); });
    for (const [type, action] of [['play', 'play'], ['pause', 'pause'], ['seeked', 'seek'], ['ratechange', 'rate']]) {
      listen(type, () => {
        const op = this.operation;
        if (action === 'seek' && op) { op.seek = media.seeking; this.settle(op); }
        if (!this.ready) return;
        if (action === 'rate' && this.rateEcho !== null && Math.abs(media.playbackRate - this.rateEcho) < 0.001) { this.rateEcho = null; return; }
        if (action === 'seek' && this.lateSeek !== null && Math.abs(media.currentTime - this.lateSeek) < 0.75) { this.lateSeek = null; return; }
        if (op) {
          const matches = action === 'seek' ? Math.abs(media.currentTime - op.position) < 0.75
            : action === 'rate' ? Math.abs(media.playbackRate - op.rate) < 0.001
            : !media.paused === op.playing;
          if (matches) return;
          this.cancelOperation(); // a different user action supersedes the pending remote operation
        }
        if (this.followingHost) {
          const request = this.snapshot('request');
          request.requested = action as WatchControl;
          if (action === 'rate') request.rate = media.playbackRate;
          emit(request);
          if (this.shared?.event.fileId === this.fileId) this.apply(this.shared, true);
          else this.applyState(this.initial.position, this.baseRate, false, true);
          return;
        }
        this.localIntent = true;
        if (action === 'rate') { if (this.nudge) clearTimeout(this.nudge); this.nudge = undefined; this.baseRate = media.playbackRate; }
        else this.restoreRate();
        if (this.enabled) emit(this.snapshot(action));
      });
    }
    listen('error', () => { this.ready = false; this.cancelOperation(); });
    const detach = () => {
      for (const [type, fn] of listeners) media.removeEventListener(type, fn);
      this.cancelOperation(); this.restoreRate();
      if (this.media === media) { this.media = null; this.ready = false; }
      if (this.detach === detach) this.detach = null;
    };
    this.detach = detach;
    return detach;
  }
  receive(event: WatchPlaybackEvent): boolean {
    const receivedAt = this.now();
    if (!this.receiver.accept({ ...event, t: 'sync-v2', pub: '', sig: '' }, receivedAt)) return false;
    if (event.action === 'leave') {
      if (this.pending?.event.memberId === event.memberId && this.pending.event.fileId === event.fileId) this.pending = null;
      return false;
    }
    if (!this.enabled || !event.together || event.action === 'react' || event.action === 'request') return false;
    if (this.hostId && event.memberId !== this.hostId) return false;
    const sample = { event, receivedAt };
    const firstHost = this.followingHost && (!this.shared || this.media?.paused === event.playing);
    if (this.hostId) this.shared = sample;
    if ((event.action === 'track' || this.hostId === event.memberId && ['beat', 'join', 'state'].includes(event.action)) && event.fileId !== this.fileId) {
      this.pending = sample; this.cancelOperation(); this.ready = false;
      return true;
    }
    if (event.fileId !== this.fileId) return false;
    const heartbeat = event.action === 'beat' || event.action === 'join';
    if (heartbeat && ((!event.playing && !this.followingHost) || this.operation || this.pending)) return false;
    if (!this.media || !this.ready) { this.pending = sample; return false; }
    this.apply(sample, !heartbeat || firstHost);
    return false;
  }
  /** Accepted requests are executed by the host and broadcast as ordinary controls. */
  execute(input: WatchInput): void {
    if (!this.media || !this.ready || !WATCH_CONTROLS.includes(input.action as WatchControl)) return;
    try {
      if (input.action === 'seek') this.media.currentTime = input.position;
      else if (input.action === 'rate') this.media.playbackRate = input.rate || 1;
      else if (input.action === 'pause') this.media.pause();
      else if (input.action === 'play') void this.media.play().catch(() => {});
    } catch { /* A source can become unavailable after the request. */ }
  }
  private apply(sample: Sample, explicit: boolean): void {
    const m = this.media;
    if (!m) return;
    const e = sample.event, expected = watchPosition(e, sample.receivedAt, this.now());
    if (explicit && e.action === 'pause') this.localIntent = true;
    if (!explicit) {
      if (m.paused && this.localIntent) return; // a deliberate pause is not buffering
      const drift = expected - m.currentTime;
      if (drift <= SOFT_DRIFT) {
        if (drift >= -SOFT_DRIFT) { this.restoreRate(); this.baseRate = e.rate; this.setRate(e.rate); }
        return; // presence never rewinds an established viewer
      }
      if (!m.paused && drift <= HARD_DRIFT) {
        this.cancelOperation(); this.restoreRate(); this.baseRate = e.rate;
        this.setRate(Math.min(4, e.rate * (1 + Math.min(0.05, drift * 0.04))));
        this.nudge = setTimeout(() => { this.nudge = undefined; this.setRate(this.baseRate); }, 2500);
        return;
      }
    }
    const seek = e.action === 'seek' || e.action === 'track' || Math.abs(expected - m.currentTime) > HARD_DRIFT
      || e.action === 'pause' && Math.abs(expected - m.currentTime) > 0.5;
    this.applyState(expected, e.rate, e.action === 'play' || e.action !== 'pause' && e.playing, seek);
  }
  private setRate(rate: number): void {
    if (!this.media || Math.abs(this.media.playbackRate - rate) < 0.001) return;
    this.rateEcho = rate; this.media.playbackRate = rate;
  }
  private restoreRate(): void {
    if (this.nudge) clearTimeout(this.nudge); this.nudge = undefined;
    this.setRate(this.baseRate);
  }
  private applyState(position: number, rate: number, playing: boolean, seek: boolean): void {
    const m = this.media;
    if (!m) return;
    this.cancelOperation(); this.restoreRate(); this.baseRate = rate;
    const target = Number.isFinite(m.duration) ? Math.min(position, Math.max(0, m.duration - (playing ? 0.05 : 0))) : position;
    const op: Operation = { position: target, rate, playing, seek: false, play: false };
    this.operation = op;
    op.deadline = setTimeout(() => { if (this.operation === op) this.cancelOperation(); }, WATCH_OPERATION_TIMEOUT_MS);
    try {
      this.setRate(rate);
      if (seek && Math.abs(m.currentTime - target) > 0.05) { op.seek = true; this.lateSeek = target; m.currentTime = target; }
      if (playing && m.paused) {
        op.play = true;
        void m.play().catch(() => {}).finally(() => { if (this.operation === op) { op.play = false; this.settle(op); } });
      } else if (!playing) m.pause();
    } catch { op.seek = false; op.play = false; }
    this.settle(op);
  }
  private settle(op: Operation): void {
    if (this.operation !== op || op.seek || op.play || this.media?.seeking) return;
    if (op.settle) clearTimeout(op.settle);
    op.settle = setTimeout(() => { if (this.operation === op) this.cancelOperation(); }, 120);
  }
  private cancelOperation(): void {
    if (this.operation?.deadline) clearTimeout(this.operation.deadline);
    if (this.operation?.settle) clearTimeout(this.operation.settle);
    this.operation = null;
  }
  dispose(): void {
    this.detach?.(); this.pending = null; this.shared = null; this.lateSeek = null;
    this.receiver = new WatchReceiver();
  }
}
