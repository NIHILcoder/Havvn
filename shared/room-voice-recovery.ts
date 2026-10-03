/** Local WebRTC recovery only: presence/signaling cannot replenish the budget. */
export type VoiceLinkState = 'connecting' | 'connected' | 'reconnecting' | 'failed';
export const VOICE_CONNECT_TIMEOUT_MS = 20_000;
export const VOICE_DISCONNECT_GRACE_MS = 5_000;
export const VOICE_STABLE_MS = 30_000;
export const VOICE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

export class VoiceLinkRecovery {
  state: VoiceLinkState = 'connecting';
  attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastExplicit = -Infinity;
  private lastNetwork = -Infinity;

  constructor(private restart: () => void, private changed: () => void, private now = () => Date.now(), private connection?: () => RTCPeerConnectionState, private spread: () => number = () => 0) {
    this.waitForConnection();
  }

  update(connection: RTCPeerConnectionState): void {
    if (this.closed) return;
    if (connection === 'connected') {
      this.clearTimer();
      this.setState('connected');
      if (!this.stableTimer) this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.attempts = 0;
        this.changed();
      }, VOICE_STABLE_MS);
      return;
    }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    if (connection === 'closed') { this.clearTimer(); this.setState('failed'); return; }
    if (this.state === 'failed') return; // only explicit retry/network change reopens a spent budget
    if (connection === 'failed') { this.scheduleRetry(); return; }
    if (connection === 'disconnected' && this.state === 'connected') {
      this.setState('reconnecting');
      this.timer = setTimeout(() => { this.timer = null; this.scheduleRetry(); }, VOICE_DISCONNECT_GRACE_MS);
    } else if (!this.timer) {
      this.setState(this.attempts ? 'reconnecting' : 'connecting');
      this.waitForConnection();
    }
  }

  retry(): void {
    if (this.closed || this.now() - this.lastExplicit < 1_000) return;
    this.lastExplicit = this.now();
    this.resetAndRestart();
  }

  networkChanged(): void {
    if (this.closed || this.now() - this.lastNetwork < VOICE_STABLE_MS) return;
    this.lastNetwork = this.now();
    // A real local network event may reopen a terminal budget, at most once/30s.
    this.resetAndRestart();
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
  }

  private setState(state: VoiceLinkState): void {
    if (state !== this.state) { this.state = state; this.changed(); }
  }
  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  private waitForConnection(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      // Successful ICE restart need not emit another connectionstatechange.
      if (this.connection?.() === 'connected') this.update('connected');
      else this.scheduleRetry();
    }, VOICE_CONNECT_TIMEOUT_MS);
  }
  private scheduleRetry(): void {
    // Do not move an already pending retry forward on repeated failed events.
    if (this.state === 'failed' || this.timer && this.state === 'reconnecting') return;
    this.clearTimer();
    if (this.attempts >= VOICE_RETRY_DELAYS_MS.length) { this.setState('failed'); return; }
    this.setState('reconnecting');
    this.timer = setTimeout(() => { this.timer = null; this.doRestart(); }, VOICE_RETRY_DELAYS_MS[this.attempts] + Math.max(0, Math.min(250, this.spread())));
  }
  private resetAndRestart(): void {
    this.clearTimer();
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    this.attempts = 0;
    this.doRestart();
  }
  private doRestart(): void {
    if (this.closed) return;
    this.attempts++;
    this.state = 'reconnecting';
    this.changed();
    this.waitForConnection();
    try { this.restart(); } catch { this.clearTimer(); this.scheduleRetry(); }
  }
}
