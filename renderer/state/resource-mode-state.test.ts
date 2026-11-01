import { afterEach, expect, it, vi } from 'vitest';
import { createResourceModeState } from './resource-mode-state';
import { resolveResourceMode, type ResourceModeSnapshot } from '../../shared/resource-mode';
afterEach(() => vi.useRealTimers());
it('a late initial read cannot overwrite a newer power event', async () => {
  let receive!: (value: ResourceModeSnapshot) => void, finish!: (value: ResourceModeSnapshot) => void;
  const state = createResourceModeState(() => ({ get: () => new Promise(resolve => { finish = resolve; }), onChanged: fn => { receive = fn; return () => {}; } }));
  const release = state.retain(); receive(resolveResourceMode('auto', 'battery', 2)); finish(resolveResourceMode('auto', 'ac', 1));
  await Promise.resolve(); expect(state.getSnapshot().snapshot.economy).toBe(true); release();
});
it('retains the last restriction on failure, retries, and stops retrying when released', async () => {
  vi.useFakeTimers(); const get = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(resolveResourceMode('auto', 'ac', 2));
  const off = vi.fn(), state = createResourceModeState(() => ({ get, onChanged: () => off }));
  state.receive(resolveResourceMode('auto', 'battery', 1)); const release = state.retain(); await vi.advanceTimersByTimeAsync(0);
  expect(state.getSnapshot()).toMatchObject({ status: 'unavailable', snapshot: { economy: true } });
  await vi.advanceTimersByTimeAsync(5000); expect(state.getSnapshot()).toMatchObject({ status: 'ready', snapshot: { economy: false } });
  release(); await vi.advanceTimersByTimeAsync(5000); expect(get).toHaveBeenCalledTimes(2); expect(off).toHaveBeenCalledOnce();
});
it('shares one source subscription and rejects malformed snapshots', async () => {
  const onChanged = vi.fn(() => vi.fn()), state = createResourceModeState(() => ({ get: async () => resolveResourceMode('normal', 'unknown'), onChanged }));
  const a = state.retain(), b = state.retain(); await Promise.resolve(); expect(onChanged).toHaveBeenCalledOnce();
  state.receive({}); expect(state.getSnapshot().snapshot.economy).toBe(false); a(); b();
});
