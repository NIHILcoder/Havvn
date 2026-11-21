import { afterEach, expect, it, vi } from 'vitest';
import { RoomSyncWorkQueue } from './room-sync-work';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

it('preserves cleanup failures instead of reporting a clean cancellation', async () => {
  const q = new RoomSyncWorkQueue(), owner = {};
  await expect(q.run({ owner }, async () => { queueMicrotask(() => q.cancel(owner)); return 'private snapshot'; },
    async () => { throw Error('cleanup denied'); })).rejects.toThrow('cleanup denied');
  expect(await q.run({ owner: {} }, async () => 'next')).toBe('next');
});

it('disposes a result canceled at completion before freeing the slot', async () => {
  const q = new RoomSyncWorkQueue(), owner = {}, cleanup = deferred(), next = vi.fn(), dispose = vi.fn(async () => { await cleanup.promise; });
  const task = q.run({ owner }, async () => { queueMicrotask(() => q.cancel(owner)); return 'private snapshot'; }, dispose).catch(error => error.message);
  const waiting = q.run({ owner: {} }, async () => next());
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith('private snapshot'));
  expect(next).not.toHaveBeenCalled(); cleanup.resolve(); expect(await task).toBe('Sync preparation canceled'); await waiting;
});

it('bounds actual concurrency across owners and advances after a failed task', async () => {
  const q = new RoomSyncWorkQueue(), hold = deferred(); let active = 0, peak = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => q.run({ owner: {} }, async () => {
    active++; peak = Math.max(peak, active); try { await hold.promise; if (index === 1) throw Error('disk error'); return index; } finally { active--; }
  }).catch(error => error.message));
  expect(active).toBe(1); hold.resolve(); expect(await Promise.all(tasks)).toEqual([0, 'disk error', 2, 3, 4, 5]); expect(peak).toBe(1);
});
it('gives interactive tasks priority while guaranteeing FIFO progress for background owners', async () => {
  const q = new RoomSyncWorkQueue(), hold = deferred(), order: string[] = [], background = {};
  const first = q.run({ owner: {} }, async () => { order.push('first'); await hold.promise; });
  const tasks = [q.run({ owner: background, priority: 'background' }, async () => { order.push('background'); }),
    ...Array.from({ length: 8 }, (_, i) => q.run({ owner: {}, priority: 'interactive' }, async () => { order.push('i' + i); }))];
  expect(q.view(background)).toEqual({ active: 0, waiting: 1, position: 3, reason: 'resource-slot' });
  hold.resolve(); await Promise.all([first, ...tasks]); expect(order.slice(0, 4)).toEqual(['first', 'i0', 'i1', 'background']);
  expect(order.filter(item => item.startsWith('i'))).toEqual(Array.from({ length: 8 }, (_, i) => 'i' + i));
});
it('cancels a queued owner without starting disk work or disturbing another owner', async () => {
  const q = new RoomSyncWorkQueue(), hold = deferred(), canceled = {}, start = vi.fn();
  const active = q.run({ owner: {} }, () => hold.promise);
  const waiting = q.run({ owner: canceled }, async () => start()).catch(error => error.message);
  const survivor = q.run({ owner: {} }, async () => 'ok'); q.cancel(canceled); q.cancel(canceled);
  expect(await waiting).toBe('Sync preparation canceled'); expect(start).not.toHaveBeenCalled(); expect(q.view(canceled)).toBeUndefined();
  hold.resolve(); await active; expect(await survivor).toBe('ok');
});
it('keeps an aborted active slot occupied until cleanup settles', async () => {
  const q = new RoomSyncWorkQueue(), owner = {}, cleanup = deferred(), stopped = deferred(), next = vi.fn();
  const active = q.run({ owner }, async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    stopped.resolve(); await cleanup.promise;
  }).catch(error => error.message);
  const waiting = q.run({ owner: {} }, async () => next()); q.cancel(owner); await stopped.promise;
  expect(q.view(owner)?.active).toBe(1); expect(next).not.toHaveBeenCalled(); cleanup.resolve();
  expect(await active).toBe('Sync preparation canceled'); await waiting; expect(next).toHaveBeenCalledOnce();
});
it('detects stale authorization while queued and aborts active streams', async () => {
  vi.useFakeTimers(); const q = new RoomSyncWorkQueue(), owner = {}, hold = deferred(); let valid = true;
  const first = q.run({ owner: {} }, () => hold.promise);
  const waiting = q.run({ owner, current: () => valid }, async () => 'must not start').catch(error => error.message);
  valid = false; await vi.advanceTimersByTimeAsync(50); expect(await waiting).toBe('Sync preparation canceled'); hold.resolve(); await first;
  await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
});
it('bounds waiting work, allows retry after cancellation and does not cancel interactive work when a watcher closes', async () => {
  const q = new RoomSyncWorkQueue(1, 2), owner = {}, hold = deferred();
  const active = q.run({ owner }, () => hold.promise), waiting = q.run({ owner, priority: 'background' }, async () => 1).catch(error => error.message);
  await expect(q.run({ owner: {} }, async () => 2)).rejects.toThrow('queue is full');
  q.cancel(owner, 'background'); expect(await waiting).toBe('Sync preparation canceled'); expect(q.view(owner)?.active).toBe(1);
  const retry = q.run({ owner: {} }, async () => 2); hold.resolve(); await active; expect(await retry).toBe(2);
});
