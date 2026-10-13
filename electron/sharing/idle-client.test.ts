import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleClientReaper } from './idle-client';
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
const client = () => Object.assign(new EventEmitter(), { torrents: [] as object[], destroyed: false });
describe('empty client retirement', () => {
  it('retires an unused client after the grace period', () => {
    const retire = vi.fn(), reaper = new IdleClientReaper(retire), c = client(); reaper.watch(c);
    vi.advanceTimersByTime(4999); expect(retire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(retire).toHaveBeenCalledExactlyOnceWith(c);
  });
  it('keeps active torrents and pending hashing alive', () => {
    const retire = vi.fn(), reaper = new IdleClientReaper(retire), c = client();
    const release = reaper.hold(c); vi.advanceTimersByTime(30000); expect(retire).not.toHaveBeenCalled();
    c.torrents.push({}); release(); release(); vi.advanceTimersByTime(10000); expect(retire).not.toHaveBeenCalled();
    c.torrents = []; c.emit('remove'); vi.advanceTimersByTime(5000); expect(retire).toHaveBeenCalledOnce();
  });
  it('rechecks for a new torrent just before retirement', () => {
    const retire = vi.fn(), reaper = new IdleClientReaper(retire), c = client(); reaper.watch(c);
    vi.advanceTimersByTime(4000); c.torrents.push({}); vi.advanceTimersByTime(1000); expect(retire).not.toHaveBeenCalled();
    c.torrents = []; c.emit('remove'); vi.advanceTimersByTime(5000); expect(retire).toHaveBeenCalledOnce();
  });
  it('clears timers and listeners on client close', () => {
    const retire = vi.fn(), reaper = new IdleClientReaper(retire), c = client(); reaper.watch(c);
    c.destroyed = true; c.emit('close'); vi.runAllTimers();
    expect(retire).not.toHaveBeenCalled(); expect(c.listenerCount('remove')).toBe(0);
  });
});
