import { beforeEach, expect, it, vi } from 'vitest';
import type { NotificationEnvironment } from '../../shared/notification-policy';
const mocks = vi.hoisted(() => ({ shown: [] as Array<Record<string, unknown>>, supported: true,
  env: {} as NotificationEnvironment, read: vi.fn() }));
vi.mock('electron', () => ({ Notification: class {
  static isSupported() { return mocks.supported; }
  constructor(private options: Record<string, unknown>) {}
  on() { return this; }
  show() { mocks.shown.push(this.options); }
} }));
vi.mock('./index', () => ({ getAppIconPath: () => '' }));
vi.mock('../db/store', () => ({ readNotificationEnvironments: (contexts: unknown[]) => { mocks.read(); return contexts.map(() => structuredClone(mocks.env)); } }));
import { setNotificationWindow, showOsNotification } from './os-notify';
import { DEFAULT_NOTIFICATION_POLICY } from '../../shared/notification-policy';
const send = vi.fn();
beforeEach(() => {
  mocks.shown = []; mocks.supported = true; vi.clearAllMocks();
  const policy = structuredClone(DEFAULT_NOTIFICATION_POLICY); policy.summaries.enabled = false;
  mocks.env = { settings: { enableNotifications: true, enableSounds: true, notifyOnComplete: true, notifyOnError: true, notificationPolicy: policy } };
  setNotificationWindow(() => ({ isDestroyed: () => false, webContents: { send } }) as never);
});
it('redacts both native title/body and uses a separate content-free sound signal', async () => {
  mocks.env.settings.notificationPolicy!.showContent = false;
  showOsNotification('PRIVATE_TITLE', 'PRIVATE_BODY', { context: { kind: 'download-complete' } });
  await vi.waitFor(() => expect(mocks.shown).toHaveLength(1));
  expect(JSON.stringify(mocks.shown)).not.toContain('PRIVATE'); expect(mocks.shown[0].silent).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith('app:notificationSound');
});
it('can sound with no native popup, and never asks the OS to play a second sound', async () => {
  mocks.env.settings.enableNotifications = false;
  showOsNotification('Title', 'Body');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce()); expect(mocks.shown).toHaveLength(0);
});
it('keeps silent informational notices silent even when app sounds are enabled', async () => {
  showOsNotification('Tray hint', 'Body', { silent: true });
  await vi.waitFor(() => expect(mocks.shown).toHaveLength(1)); expect(send).not.toHaveBeenCalled();
});
