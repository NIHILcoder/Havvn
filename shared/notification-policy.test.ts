import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_POLICY, inQuietHours, resolveNotificationPolicy, validateNotificationPolicy, validateNotificationRule, type NotificationEnvironment } from './notification-policy';
import { validateSettingsTransfer } from './settings-transfer';

const env = (): NotificationEnvironment => ({ settings: { enableNotifications: true, enableSounds: true, notifyOnComplete: true, notifyOnError: true, notificationPolicy: structuredClone(DEFAULT_NOTIFICATION_POLICY) } });
const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m);
describe('local notification policy', () => {
  it.each([[21, 59, false], [22, 0, true], [23, 59, true], [0, 0, true], [7, 59, true], [8, 0, false]])('crosses midnight at %s:%s', (hour, minute, quiet) => {
    const policy = structuredClone(DEFAULT_NOTIFICATION_POLICY); policy.quietHours.enabled = true;
    expect(inQuietHours(policy, at(hour as number, minute as number))).toBe(quiet);
  });
  it('re-evaluates the supplied local clock after a zone/clock change and treats equal endpoints as all day', () => {
    const p = structuredClone(DEFAULT_NOTIFICATION_POLICY); p.quietHours.enabled = true;
    expect(inQuietHours(p, at(12))).toBe(false); expect(inQuietHours(p, at(23))).toBe(true);
    p.quietHours.start = p.quietHours.end = '08:00'; expect(inQuietHours(p, at(12))).toBe(true);
    p.quietHours.start = '09:00'; p.quietHours.end = '17:00';
    expect(inQuietHours(p, at(9))).toBe(true); expect(inQuietHours(p, at(17))).toBe(false);
  });
  it('keeps sound independent of popups and makes global privacy a cap', () => {
    const e = env(); e.settings.enableNotifications = false; e.categoryRule = { popups: true, sound: true, showContent: true };
    e.settings.notificationPolicy!.showContent = false;
    expect(resolveNotificationPolicy({ kind: 'download-complete' }, e, at(12))).toMatchObject({ popups: false, sound: true, showContent: false });
    e.settings.enableNotifications = true; e.settings.enableSounds = false;
    expect(resolveNotificationPolicy({ kind: 'download-complete' }, e, at(12))).toMatchObject({ popups: true, sound: false });
  });
  it('applies only the current room/category rule and respects room mention mode', () => {
    const e = env(); e.roomRule = { popups: false }; e.categoryRule = { sound: false };
    expect(resolveNotificationPolicy({ kind: 'room-message', roomId: 'a' }, e, at(12))).toMatchObject({ popups: false, sound: true });
    expect(resolveNotificationPolicy({ kind: 'download-complete', categoryId: 'movies' }, e, at(12))).toMatchObject({ popups: true, sound: false });
    e.roomMode = 'mentions'; expect(resolveNotificationPolicy({ kind: 'room-message', roomId: 'a' }, e).reason).toBe('mentions-only');
    expect(resolveNotificationPolicy({ kind: 'room-message', roomId: 'a', urgent: true }, e).reason).toBeUndefined();
    e.roomMode = 'off'; expect(resolveNotificationPolicy({ kind: 'room-message', roomId: 'a', urgent: true }, e).sound).toBe(false);
  });
  it('filters completion/errors and unavailable objects independently of OS delivery', () => {
    const e = env(); e.settings.notifyOnComplete = false; e.settings.notifyOnError = false;
    expect(resolveNotificationPolicy({ kind: 'download-complete' }, e).reason).toBe('completion-disabled');
    expect(resolveNotificationPolicy({ kind: 'download-error' }, e).reason).toBe('errors-disabled');
    e.available = false; expect(resolveNotificationPolicy({ kind: 'rss' }, e).reason).toBe('unavailable');
  });
  it.each([{ quietHours: { start: '25:00' } }, { quietHours: { end: '08:90' } }, { summaries: { windowSeconds: 1 } }, { summaries: { windowSeconds: 31 } }, { showContent: 'false' }])('rejects malformed global policy %j', input => {
    expect(() => validateNotificationPolicy(input)).toThrow('Invalid notification');
  });
  it('validates and transfers global/category rules while leaving room preferences local', () => {
    expect(() => validateNotificationRule({ popups: 0 })).toThrow();
    const bundle = validateSettingsTransfer({ version: 1, settings: { notificationPolicy: DEFAULT_NOTIFICATION_POLICY },
      categories: [{ id: 'movies', name: 'Movies', color: '#ff6600', icon: 'film', notificationRule: { popups: false, showContent: false } }], rooms: [{ roomId: 'private' }] });
    expect(bundle.settings.notificationPolicy).toEqual(DEFAULT_NOTIFICATION_POLICY);
    expect(bundle.categories![0].notificationRule).toEqual({ popups: false, showContent: false }); expect(bundle).not.toHaveProperty('rooms');
  });
});
