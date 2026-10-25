import { afterEach, expect, it, vi } from 'vitest';
import { NotificationCenter, type NotificationNotice } from './notification-center';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationEnvironment, type NotificationContext } from '../../shared/notification-policy';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers(); let now = new Date(2026, 9, 23, 12);
  const state: NotificationEnvironment = { settings: { enableNotifications: true, enableSounds: true, notifyOnComplete: true, notifyOnError: true, notificationPolicy: structuredClone(DEFAULT_NOTIFICATION_POLICY) } };
  const read = vi.fn(async (_context: NotificationContext) => state), popup = vi.fn(), sound = vi.fn();
  const center = new NotificationCenter({ read, popup, sound, privateMessage: () => ({ title: 'Havvn', body: 'New activity' }),
    summary: (kind, count) => ({ title: kind, body: `Events: ${count}` }) }, () => now);
  const send = (context: NotificationContext = { kind: 'download-complete' }): NotificationNotice => ({ title: 'PRIVATE_NAME', body: 'PRIVATE_TEXT', context });
  return { center, state, read, popup, sound, send, clock: (value: Date) => { now = value; } };
}
it('turns a burst of completions into one summary and one sound', async () => {
  const f = fixture(); for (let i = 0; i < 5; i++) await f.center.notify(f.send({ kind: 'download-complete', downloadId: String(i) }));
  expect(f.popup).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.popup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'download-complete', body: 'Events: 5' })); expect(f.sound).toHaveBeenCalledOnce(); f.center.dispose();
});
it('does not delay critical countdown warnings for batching but still respects quiet hours', async () => {
  const f = fixture(); await f.center.notify({ ...f.send({ kind: 'system' }), critical: true });
  expect(f.popup).toHaveBeenCalledOnce();
  f.state.settings.notificationPolicy!.quietHours = { enabled: true, start: '00:00', end: '00:00' };
  await f.center.notify({ ...f.send({ kind: 'system' }), critical: true });
  expect(f.popup).toHaveBeenCalledOnce(); f.center.dispose();
});
it('rechecks privacy at delivery and never revives content that was hidden at admission', async () => {
  const f = fixture(); await f.center.notify(f.send()); f.state.settings.notificationPolicy!.showContent = false;
  await vi.advanceTimersByTimeAsync(3000); expect(JSON.stringify(f.popup.mock.calls)).not.toContain('PRIVATE');
  await f.center.notify(f.send()); f.state.settings.notificationPolicy!.showContent = true;
  await vi.advanceTimersByTimeAsync(3000); expect(JSON.stringify(f.popup.mock.calls)).not.toContain('PRIVATE'); f.center.dispose();
});
it('does not replay notifications suppressed by quiet hours, and checks clock changes before delivery', async () => {
  const f = fixture(); f.state.settings.notificationPolicy!.quietHours.enabled = true;
  f.clock(new Date(2026, 9, 23, 23)); await f.center.notify(f.send()); f.clock(new Date(2026, 9, 24, 12));
  await vi.advanceTimersByTimeAsync(3000); expect(f.popup).not.toHaveBeenCalled();
  await f.center.notify(f.send()); f.clock(new Date(2026, 9, 24, 23)); await vi.advanceTimersByTimeAsync(3000);
  expect(f.popup).not.toHaveBeenCalled(); expect(f.sound).not.toHaveBeenCalled(); f.center.dispose();
});
it('keeps room rules isolated and rechecks a mute applied during the batch window', async () => {
  const f = fixture(); const muted = new Set(['a']);
  f.read.mockImplementation(async context => ({ ...f.state, roomMode: muted.has(context.roomId!) ? 'off' : 'all' }));
  await f.center.notify(f.send({ kind: 'room-message', roomId: 'a' })); await f.center.notify(f.send({ kind: 'room-message', roomId: 'b' }));
  await vi.advanceTimersByTimeAsync(3000); expect(f.popup).toHaveBeenCalledOnce();
  await f.center.notify(f.send({ kind: 'room-message', roomId: 'b' })); muted.add('b'); await vi.advanceTimersByTimeAsync(3000);
  expect(f.popup).toHaveBeenCalledOnce(); f.center.dispose();
});
it('supports sound without any popup and refuses output after settings failure or disposal', async () => {
  const f = fixture(); f.state.settings.enableNotifications = false;
  await f.center.notify(f.send()); await vi.advanceTimersByTimeAsync(3000);
  expect(f.popup).not.toHaveBeenCalled(); expect(f.sound).toHaveBeenCalledOnce();
  f.read.mockRejectedValueOnce(Error('store failed')); await f.center.notify(f.send());
  await f.center.notify(f.send()); f.center.dispose(); await vi.advanceTimersByTimeAsync(3000); expect(f.sound).toHaveBeenCalledOnce();
});
it('bounds queued events, isolates system groups and ignores deleted objects before delivery', async () => {
  const f = fixture(); for (let i = 0; i < 200; i++) await f.center.notify(f.send({ kind: 'system', group: 'disk' }));
  await f.center.notify(f.send({ kind: 'system', group: 'vpn' })); await vi.advanceTimersByTimeAsync(3000);
  expect(f.popup).toHaveBeenCalledTimes(2); expect(f.popup.mock.calls[0][0].body).toBe('Events: 100');
  await f.center.notify(f.send()); f.state.available = false; await vi.advanceTimersByTimeAsync(3000); expect(f.popup).toHaveBeenCalledTimes(2); f.center.dispose();
});
