import { expect, it, vi } from 'vitest';
import { ResourceModeController } from './resource-mode-controller';
import type { ResourceMode, PowerSource } from '../../shared/resource-mode';

function fixture() {
  const saved = { mode: 'auto' as ResourceMode, power: 'ac' as PowerSource };
  const writeMode = vi.fn(async (mode: ResourceMode) => { saved.mode = mode; });
  const readMode = vi.fn(async () => saved.mode), readPower = vi.fn(() => saved.power);
  const controller = new ResourceModeController({ readMode, writeMode, readPower });
  return { saved, controller, readMode, readPower, writeMode };
}
it('reacts to power changes while a persisted manual override wins until auto is chosen', async () => {
  const f = fixture(); await f.controller.refresh(); expect(f.controller.peek().economy).toBe(false);
  f.controller.receivePower('battery'); expect(f.controller.peek().economy).toBe(true);
  f.saved.power = 'battery'; await f.controller.setMode('normal');
  expect(f.controller.peek().economy).toBe(false); f.controller.receivePower('ac'); expect(f.saved.mode).toBe('normal');
  await f.controller.setMode('economy'); expect(f.controller.peek().economy).toBe(true);
});
it('unknown or failed power queries stay unknown, and manual economy still works', async () => {
  const f = fixture(); f.readPower.mockImplementation(() => { throw Error('unavailable'); });
  await f.controller.refresh(); expect(f.controller.peek()).toMatchObject({ power: 'unknown', economy: false, source: 'unknown' });
  await f.controller.setMode('economy'); expect(f.controller.peek()).toMatchObject({ power: 'unknown', economy: true, source: 'manual' });
});
it('a power event arriving during an initial settings read is not overwritten by an older query', async () => {
  const f = fixture(); let finish!: (mode: ResourceMode) => void;
  f.readMode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.controller.refresh(); f.controller.receivePower('battery'); finish('auto'); await pending;
  expect(f.controller.peek()).toMatchObject({ mode: 'auto', power: 'battery', economy: true }); expect(f.readPower).not.toHaveBeenCalled();
});
it('sequential saves survive one failed write and persist only the selected mode', async () => {
  const f = fixture(); f.writeMode.mockRejectedValueOnce(Error('disk unavailable'));
  await expect(f.controller.setMode('economy')).rejects.toThrow();
  await f.controller.setMode('normal'); expect(f.saved.mode).toBe('normal');
  expect(f.writeMode.mock.lastCall).toEqual(['normal']);
});
it('same state does not republish; unsubscribe and an observer failure do not block other consumers', async () => {
  const f = fixture(), listener = vi.fn(); f.controller.subscribe(() => { throw Error('closed window'); });
  const off = f.controller.subscribe(listener); await f.controller.refresh(); await f.controller.refresh(); expect(listener).toHaveBeenCalledTimes(1);
  off(); f.controller.receivePower('battery'); expect(listener).toHaveBeenCalledTimes(1);
});
