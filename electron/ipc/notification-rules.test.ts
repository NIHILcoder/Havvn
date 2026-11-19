import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handler: undefined as undefined | ((...args: any[]) => any) }));
vi.mock('electron', () => ({ ipcMain: { handle: (_name: string, fn: (...args: unknown[]) => unknown) => { mocks.handler = fn; } } }));
import { registerNotificationRulesIpc } from './notification-rules';

it('accepts only the current main frame and validated local rules without trusting renderer room IDs', async () => {
  const frame = {}, sender = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: sender }, save = vi.fn().mockResolvedValue({ ok: true });
  registerNotificationRulesIpc(() => window as never, save);
  const call = mocks.handler!, event = { sender, senderFrame: frame };
  expect(() => call({ sender: {}, senderFrame: frame }, 'room', {})).toThrow('Untrusted');
  expect(() => call({ sender, senderFrame: {} }, 'room', {})).toThrow('Untrusted');
  expect(() => call(event, '__proto__', {})).toThrow('Invalid room');
  expect(() => call(event, 'room', { sound: 'false' })).toThrow('Invalid notification');
  expect(() => call(event, 'room', {}, 'invalid')).toThrow('Invalid room notification mode');
  expect(save).not.toHaveBeenCalled();
  expect(await call(event, 'room', { sound: false, unexpected: 'ignored' }, 'mentions')).toEqual({ ok: true });
  expect(save).toHaveBeenCalledExactlyOnceWith('room', { sound: false }, 'mentions');
});
