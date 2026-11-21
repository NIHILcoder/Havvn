import { expect, it, vi } from 'vitest';
import { createOperationOwner } from '../../shared/operations';
import { createOperationObserver } from './operation-observer';

it('keeps a newer owner result when reads finish out of order and retains it on connection loss', async () => {
  const owner = createOperationOwner(), id = owner.start('write-export');
  const old = owner.snapshot(); owner.finish(id, 'succeeded'); const latest = owner.snapshot();
  const read = vi.fn(async () => latest);
  let finish!: (value: typeof old) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const observer = createOperationObserver({ read, subscribe: () => () => {} });
  const stale = observer.refresh(); await observer.refresh(); finish(old); await stale;
  expect(observer.getSnapshot()).toEqual({ operation: latest, unavailable: false });
  read.mockRejectedValueOnce(new Error('lost IPC')); await observer.refresh();
  expect(observer.getSnapshot()).toEqual({ operation: latest, unavailable: true });
});
it('uses one subscription, drops responses after disposal and refreshes on remount', async () => {
  let finish!: (value: null) => void;
  const read = vi.fn(() => new Promise<null>(resolve => { finish = resolve; })), off = vi.fn(), subscribe = vi.fn(() => off);
  const observer = createOperationObserver({ read, subscribe });
  const listener = vi.fn(); observer.subscribe(listener);
  const a = observer.acquire(), b = observer.acquire();
  expect(subscribe).toHaveBeenCalledTimes(1);
  a(); a(); expect(off).not.toHaveBeenCalled(); b(); expect(off).toHaveBeenCalledTimes(1);
  finish(null); await Promise.resolve(); expect(listener).not.toHaveBeenCalled();
  const c = observer.acquire(); expect(subscribe).toHaveBeenCalledTimes(2); c();
});
