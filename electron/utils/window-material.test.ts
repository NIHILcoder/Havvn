import { describe, it, expect, vi } from 'vitest';
import { WindowMaterial } from './window-material';
const fakeWindow = () => ({ isDestroyed: vi.fn(() => false), setBackgroundColor: vi.fn(),
  setBackgroundMaterial: vi.fn(), once: vi.fn() });
describe('native window material lifecycle', () => {
  it('updates registered UI windows live and restores opaque mode', () => {
    const controller = new WindowMaterial(true), main = fakeWindow(), child = fakeWindow();
    controller.register(main);
    expect(controller.setEnabled(true).active).toBe(true);
    controller.register(child);
    expect(child.setBackgroundMaterial).toHaveBeenLastCalledWith('acrylic');
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith('#00000000');
    controller.setEnabled(false);
    expect(child.setBackgroundMaterial).toHaveBeenLastCalledWith('none');
    expect(main.setBackgroundColor).toHaveBeenLastCalledWith('#141519');
  });
  it('keeps unsupported systems opaque without calling unsupported APIs', () => {
    const controller = new WindowMaterial(false), win = fakeWindow(); controller.register(win);
    expect(controller.setEnabled(true)).toEqual({ enabled: true, active: false, reason: 'unsupported' });
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#141519');
  });
  it('falls back after a native failure and can recover on a later attempt', () => {
    const controller = new WindowMaterial(true), win = fakeWindow(); controller.register(win);
    win.setBackgroundMaterial.mockImplementationOnce(() => { throw Error('Unavailable'); });
    expect(controller.setEnabled(true).reason).toBe('failed');
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#141519');
    expect(controller.setEnabled(true).active).toBe(true);
  });
  it('forgets closed windows and does not touch destroyed windows', () => {
    const controller = new WindowMaterial(true), win = fakeWindow(); controller.register(win);
    const closed = win.once.mock.calls[0][1]; closed();
    win.setBackgroundMaterial.mockClear(); controller.setEnabled(true);
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
    const gone = fakeWindow(); gone.isDestroyed.mockReturnValue(true); controller.register(gone);
    expect(gone.setBackgroundMaterial).not.toHaveBeenCalled();
  });
});
