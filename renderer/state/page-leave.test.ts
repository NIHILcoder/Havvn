import { expect, it, vi } from 'vitest';
import { createPageLeave } from './page-leave';
it('does not leave or run destination effects after an editor refuses', async () => {
  const nav = createPageLeave(), action = vi.fn(); nav.register(() => false);
  expect(await nav.run(action)).toBe(false); expect(action).not.toHaveBeenCalled();
});
it('waits for a durable flush before opening the destination', async () => {
  const nav = createPageLeave(), calls: string[] = []; let finish!: (value: boolean) => void;
  nav.register(() => new Promise(resolve => { finish = resolve; }));
  const pending = nav.run(() => calls.push('destination')); await Promise.resolve();
  expect(calls).toEqual([]); calls.push('saved'); finish(true); expect(await pending).toBe(true);
  expect(calls).toEqual(['saved', 'destination']);
});
it('coalesces rapid destination clicks into one decision and the latest destination', async () => {
  const nav = createPageLeave(), first = vi.fn(), last = vi.fn(); let finish!: (value: boolean) => void;
  const guard = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })); nav.register(guard);
  const pending = nav.run(first); expect(nav.run(last)).toBe(pending); await Promise.resolve(); finish(true); await pending;
  expect(guard).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled(); expect(last).toHaveBeenCalledOnce();
});
it('a failed flush keeps the page and a later retry can succeed', async () => {
  const nav = createPageLeave(), action = vi.fn(); let fail = true;
  nav.register(() => { if (fail) throw Error('disk full'); return true; });
  expect(await nav.run(action)).toBe(false); fail = false; expect(await nav.run(action)).toBe(true); expect(action).toHaveBeenCalledOnce();
});
it('unregisters closed editors and checks the most recently mounted editor first', async () => {
  const nav = createPageLeave(), calls: string[] = [];
  nav.register(() => { calls.push('outer'); return true; });
  const remove = nav.register(() => { calls.push('inner'); return false; });
  expect(await nav.run(() => {})).toBe(false); expect(calls).toEqual(['inner']); remove();
  expect(await nav.run(() => {})).toBe(true); expect(calls).toEqual(['inner','outer']);
});
