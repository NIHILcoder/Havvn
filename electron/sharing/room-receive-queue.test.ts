import { describe, it, expect } from 'vitest';
import { RoomReceiveQueue } from './room-receive-queue';
import { RoomDiskBudget } from './room-disk-budget';

describe('room receive coordination', () => {
  it('shares two slots across rooms and holds them until explicit completion', async () => {
    const q = new RoomReceiveQueue(), a = {}, b = {}; let started = false;
    const one = await q.acquire(a, 'one'), two = await q.acquire(a, 'two');
    const three = q.acquire(b, 'three').then(release => { started = true; return release; });
    await Promise.resolve(); expect(started).toBe(false); one(); const release = await three;
    expect(started).toBe(true); one(); two(); release();
  });
  it('cancels only the old room session and ignores a late release after reuse', async () => {
    const q = new RoomReceiveQueue(1), old = {}, fresh = {};
    const release = await q.acquire(old, 'same'); const waiting = q.acquire(old, 'queued');
    const rejected = expect(waiting).rejects.toThrow('canceled'); q.cancel(old); await rejected;
    const current = await q.acquire(fresh, 'same'); release(); let started = false;
    const later = q.acquire(fresh, 'next').then(r => { started = true; return r; });
    await Promise.resolve(); expect(started).toBe(false); current(); (await later)();
  });
  it('bounds pending work and permits an explicit retry after space becomes available', async () => {
    const q = new RoomReceiveQueue(1, 1), room = {}; const done = await q.acquire(room, 'one');
    await expect(q.acquire(room, 'two')).rejects.toThrow('full'); done(); (await q.acquire(room, 'two'))();
  });
  it('promotes a waiting file across rooms without interrupting the active transfer', async () => {
    const q = new RoomReceiveQueue(1), a = {}, b = {};
    const release = await q.acquire(a, 'active');
    const first = q.acquire(a, 'first'), next = q.acquire(b, 'next');
    expect(q.counts(a)).toEqual({ active: 1, waiting: 1 });
    expect(q.position(b, 'next')).toBe(2);
    q.prioritize(b, 'next'); expect(q.position(b, 'next')).toBe(1);
    expect(q.position(a, 'active')).toBeUndefined();
    release(); (await next)(); (await first)();
  });
});
describe('room disk reservations', () => {
  it('counts cipher and plaintext on the same volume plus concurrent reservations', () => {
    const budget = new RoomDiskBudget(() => ({ volume: 'disk', free: 1000n }), 100n);
    const release = budget.reserve([{ root: 'cipher', bytes: 400 }, { root: 'plain', bytes: 400 }]);
    expect(() => budget.reserve([{ root: 'other-room', bytes: 101 }])).toThrow('disk space');
    release(); release(); budget.reserve([{ root: 'other-room', bytes: 900 }])();
  });
  it('rejects a multi-volume request atomically and propagates unavailable disk checks', () => {
    const budget = new RoomDiskBudget(root => ({ volume: root, free: root === 'full' ? 100n : 1000n }), 100n);
    expect(() => budget.reserve([{ root: 'open', bytes: 800 }, { root: 'full', bytes: 1 }])).toThrow();
    budget.reserve([{ root: 'open', bytes: 900 }])();
    expect(() => new RoomDiskBudget(() => { throw new Error('disk unavailable'); }).reserve([{ root: 'x', bytes: 1 }])).toThrow('unavailable');
  });
  it('rejects invalid sizes before reserving space', () => {
    const budget = new RoomDiskBudget(() => ({ volume: 'disk', free: 1000n }), 0n);
    for (const size of [-1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => budget.reserve([{ root: 'x', bytes: size }])).toThrow('size');
  });
  it('detects space consumed by another process while a receive is running', () => {
    let free = 1000n;
    const budget = new RoomDiskBudget(() => ({ volume: 'disk', free }), 100n);
    const release = budget.reserve([{ root: 'x', bytes: 800 }]);
    free = 99n; expect(() => budget.assertAvailable('x')).toThrow('disk space');
    release();
  });
});
