import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomPlaybackController, watchPosition, watchQueueDriver, observeWatchPlayback, WATCH_OPERATION_TIMEOUT_MS, type PlaybackMedia } from './room-playback';
import type { WatchInput, WatchPlaybackEvent } from './room-watch-sync';

class Media extends EventTarget implements PlaybackMedia {
  private position = 0;
  private speed = 1;
  paused = true; duration = 600; readyState = 0; seeking = false;
  listeners = new Map<string, Set<EventListener>>();
  get currentTime() { return this.position; }
  set currentTime(value: number) { this.position = value; this.seeking = true; }
  get playbackRate() { return this.speed; }
  set playbackRate(value: number) { this.speed = value; setTimeout(() => this.emit('ratechange'), 0); }
  async play() { this.paused = false; setTimeout(() => this.emit('play'), 0); }
  pause() { if (!this.paused) { this.paused = true; setTimeout(() => this.emit('pause'), 0); } }
  addEventListener(type: string, fn: EventListener) { super.addEventListener(type, fn); (this.listeners.get(type) || this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: EventListener) { super.removeEventListener(type, fn); this.listeners.get(type)?.delete(fn); }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
  loaded() { this.readyState = 1; this.emit('loadedmetadata'); }
  finishSeek() { this.seeking = false; this.emit('seeked'); }
}
function event(seq: number, patch: Partial<WatchPlaybackEvent> = {}): WatchPlaybackEvent {
  return { fileId: 'movie', memberId: 'peer', name: 'Peer', sessionId: 'a'.repeat(32), startedAt: 999_000,
    seq, action: 'seek', position: 10, rate: 1, at: Date.now(), playing: true, together: true, emoji: '', ...patch };
}
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const playback = new RoomPlaybackController(), media = new Media(), sent: WatchInput[] = [];
  playback.setTogether(true); playback.beginSource('movie');
  playback.attach(media, input => sent.push(input)); media.loaded();
  await vi.advanceTimersByTimeAsync(150);
  return { playback, media, sent };
}
afterEach(() => vi.useRealTimers());

describe('shared room playback', () => {
  it.each([0.5, 1.5, 2])('projects %sx with bounded transit and all local loading time', rate => {
    const e = event(1, { at: 1000, position: 20, rate });
    expect(watchPosition(e, 1500, 3500)).toBe(20 + 2.5 * rate);
    expect(watchPosition({ ...e, action: 'pause' }, 1500, 3500)).toBe(20);
    expect(watchPosition({ ...e, at: 30_000 }, 1500, 3500)).toBe(20 + 2 * rate);
    expect(watchPosition(e, 11_000, 31_000)).toBe(20 + 22 * rate);
  });
  it('keeps the guard for a slow seek and rejects duplicates and older sequences', async () => {
    const { playback, media, sent } = await fixture();
    const seek = event(1, { rate: 2, position: 70 });
    playback.receive(seek); await vi.advanceTimersByTimeAsync(2000);
    expect(playback.applying).toBe(true); expect(media.currentTime).toBe(70);
    playback.receive(seek); playback.receive(event(0, { position: 2 }));
    expect(media.currentTime).toBe(70);
    media.finishSeek(); await vi.advanceTimersByTimeAsync(150);
    expect(playback.applying).toBe(false); expect(sent).toEqual([]);
    playback.receive(event(2, { action: 'pause', position: 71, playing: false }));
    media.finishSeek(); await vi.advanceTimersByTimeAsync(150);
    expect(media.paused).toBe(true); expect(sent).toEqual([]); playback.dispose();
  });
  it('bounds a stuck operation but suppresses its eventual seeked event', async () => {
    const { playback, media, sent } = await fixture();
    playback.receive(event(1)); await vi.advanceTimersByTimeAsync(WATCH_OPERATION_TIMEOUT_MS + 5000);
    expect(playback.applying).toBe(false);
    media.finishSeek(); expect(sent).toEqual([]); playback.dispose();
  });
  it('lets a different local seek supersede a pending remote seek', async () => {
    const { playback, media, sent } = await fixture();
    playback.receive(event(1)); media.currentTime = 90; media.finishSeek();
    expect(sent).toMatchObject([{ action: 'seek', position: 90 }]);
    expect(playback.applying).toBe(false); playback.dispose();
  });
  it('retains only the latest command while a new track is loading', async () => {
    const { playback, media, sent } = await fixture();
    expect(playback.receive(event(1, { fileId: 'other', action: 'track', rate: 2 }))).toBe(true);
    playback.beginSource('other');
    playback.receive(event(2, { fileId: 'other', action: 'pause', position: 22, rate: 0.5, playing: false }));
    await vi.advanceTimersByTimeAsync(4000); media.loaded(); media.finishSeek();
    await vi.advanceTimersByTimeAsync(150);
    expect(media.currentTime).toBe(22); expect(media.paused).toBe(true); expect(media.playbackRate).toBe(0.5);
    expect(sent).toEqual([]); playback.dispose();
  });
  it('accounts for time spent loading without applying an old closed session', async () => {
    const { playback, media } = await fixture(); playback.beginSource('movie');
    playback.receive(event(1, { action: 'play', rate: 2 }));
    await vi.advanceTimersByTimeAsync(4000); media.loaded(); media.finishSeek();
    expect(media.currentTime).toBe(18);
    playback.receive(event(2, { action: 'leave' }));
    playback.receive(event(3, { action: 'seek', position: 2 })); expect(media.currentTime).toBe(18);
    playback.dispose();
  });
  it('lets a local queue selection cancel a queued remote state for the same target', async () => {
    const { playback, media, sent } = await fixture();
    playback.receive(event(1, { fileId: 'other', action: 'track', position: 40, playing: false }));
    playback.chooseSource('other'); media.loaded(); await vi.advanceTimersByTimeAsync(150);
    expect(media.currentTime).toBe(0); expect(media.paused).toBe(false); expect(sent).toEqual([]);
    playback.dispose();
  });
  it('restarts the current queue track without waiting for metadata that will not reload', async () => {
    const { playback, media, sent } = await fixture();
    media.currentTime = 30; media.finishSeek(); media.pause();
    await vi.advanceTimersByTimeAsync(150); sent.length = 0;
    playback.chooseSource('movie'); media.finishSeek();
    await vi.advanceTimersByTimeAsync(150);
    expect(media.currentTime).toBe(0); expect(media.paused).toBe(false);
    expect(playback.applying).toBe(false); expect(sent).toEqual([]);
    playback.receive(event(1, { action: 'pause', position: 2, playing: false }));
    media.finishSeek(); await vi.advanceTimersByTimeAsync(150);
    expect(media.currentTime).toBe(2); expect(media.paused).toBe(true);
    playback.dispose();
  });
  it('softly catches up, advertises the intended rate and respects deliberate pause', async () => {
    const { playback, media, sent } = await fixture();
    media.currentTime = 30; media.finishSeek(); sent.length = 0;
    playback.receive(event(1, { action: 'beat', position: 30.8, rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(20);
    expect(media.currentTime).toBe(30); expect(media.playbackRate).toBeGreaterThan(1.5);
    expect(playback.snapshot('beat').rate).toBe(1.5); expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2500); expect(media.playbackRate).toBe(1.5); expect(sent).toEqual([]);
    media.pause(); await vi.advanceTimersByTimeAsync(20); sent.length = 0;
    playback.receive(event(2, { action: 'beat', position: 80 }));
    expect(media.paused).toBe(true); expect(media.currentTime).toBe(30); expect(sent).toEqual([]);
    playback.dispose();
  });
  it('releases handlers and timers when moved or closed, preserves chosen rate on the new source', async () => {
    const { playback, media, sent } = await fixture();
    media.playbackRate = 2; await vi.advanceTimersByTimeAsync(20);
    playback.beginSource('next'); const next = new Media(); playback.attach(next, input => sent.push(input));
    next.loaded(); await vi.advanceTimersByTimeAsync(150);
    expect([...media.listeners.values()].every(s => s.size === 0)).toBe(true);
    expect(next.playbackRate).toBe(2);
    playback.receive(event(1, { fileId: 'next' })); playback.dispose();
    expect([...next.listeners.values()].every(s => s.size === 0)).toBe(true);
    const count = sent.length; await vi.runAllTimersAsync(); next.finishSeek(); expect(sent).toHaveLength(count);
  });
  it('chooses one automatic queue driver and excludes stale or opted-out viewers', () => {
    const viewers = [{ memberId: 'A', together: true, lastSeen: 1000 }, { memberId: 'B', together: false, lastSeen: 20_000 },
      { memberId: 'C', together: true, lastSeen: 20_000 }];
    expect(watchQueueDriver('D', viewers, 20_000)).toBe('C');
    expect(watchQueueDriver('C', [...viewers].reverse(), 20_000)).toBe('C');
  });
  it('keeps a received pause despite an older playing peer and separates waiting from pause', async () => {
    const { playback, media, sent } = await fixture(), phases: string[] = [];
    media.readyState = 3;
    const stop = observeWatchPlayback(media as unknown as HTMLMediaElement, p => phases.push(p));
    media.emit('waiting'); expect(phases.at(-1)).toBe('buffering'); expect(media.paused).toBe(false);
    expect(sent).toEqual([]);
    playback.receive(event(1, { action: 'pause', position: 0, playing: false }));
    await vi.advanceTimersByTimeAsync(150); expect(phases.at(-1)).toBe('paused');
    playback.receive(event(1, { memberId: 'other', action: 'beat', position: 50 }));
    expect(media.paused).toBe(true); expect(media.currentTime).toBe(0);
    stop(); playback.dispose(); expect([...media.listeners.values()].every(s => s.size === 0)).toBe(true);
  });
  it('follows only the chosen host, sends local controls as requests and restores the host state', async () => {
    const { playback, media, sent } = await fixture(); playback.setHost('peer', 'self', 'owner:1');
    playback.receive(event(1, { memberId: 'other', action: 'pause', playing: false, position: 40 }));
    expect(media.paused).toBe(false); expect(media.currentTime).toBe(0);
    playback.receive(event(1, { action: 'pause', playing: false, position: 20 }));
    media.finishSeek(); await vi.advanceTimersByTimeAsync(150);
    await media.play(); await vi.advanceTimersByTimeAsync(150);
    expect(sent).toMatchObject([{ action: 'request', requested: 'play' }]);
    expect(media.paused).toBe(true); expect(media.currentTime).toBe(20);
    sent.length = 0;
    playback.receive(event(2, { action: 'request', requested: 'seek', position: 50 }));
    expect(media.currentTime).toBe(20); expect(sent).toEqual([]);
    playback.setTogether(false); await media.play(); await vi.advanceTimersByTimeAsync(150);
    expect(media.paused).toBe(false); expect(sent).toEqual([]); playback.dispose();
  });
  it('joins a paused host from its beat, follows a different file and clears pending controls on handover', async () => {
    const { playback, media, sent } = await fixture(); playback.setHost('peer', 'self', 'owner:1');
    playback.receive(event(1, { action: 'beat', playing: false, position: 20 }));
    media.finishSeek(); await vi.advanceTimersByTimeAsync(150); expect(media.paused).toBe(true);
    expect(playback.receive(event(2, { action: 'beat', fileId: 'next', position: 30 }))).toBe(true);
    playback.setHost('new', 'self', 'owner:2'); playback.beginSource('next'); media.loaded();
    await vi.advanceTimersByTimeAsync(150); expect(media.paused).toBe(true); expect(media.currentTime).toBe(0);
    playback.receive(event(3, { action: 'play', position: 50, fileId: 'next' })); expect(media.paused).toBe(true);
    expect(sent).toEqual([]); playback.dispose();
  });

});
