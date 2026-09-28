import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ windows: [] as any[], lease: null as any, route: null as any }));
vi.mock('electron', () => ({ BrowserWindow: class extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { id: 17, setWindowOpenHandler: vi.fn() });
  destroyed = false;
  constructor(public options: any) { super(); state.windows.push(this); }
  removeMenu() {} isDestroyed() { return this.destroyed; }
  loadURL = vi.fn().mockResolvedValue(undefined);
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
} }));
vi.mock('./provider-network', () => ({ providerNetwork: { acquireSession: vi.fn(async () => state.lease) } }));
vi.mock('./provider-network-store', () => ({ getProviderRoute: () => state.route }));
import { openProviderLogin } from './provider-login';
import type { BrowserWindow } from 'electron';
import type { SearchProvider } from '../../shared/types';
let parent: any;
let controller: AbortController;
const provider = { id: 'test', name: 'Source', type: 'script' } as SearchProvider;
beforeEach(() => {
  state.windows = [];
  state.route = { connection: { mode: 'direct' }, origins: ['https://source.test'], mirrors: ['https://source.test/forum'] };
  controller = new AbortController();
  state.lease = { signal: controller.signal, release: vi.fn(), session: Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() }, cookies: { flushStore: vi.fn().mockResolvedValue(undefined) },
  }) };
  parent = Object.assign(new EventEmitter(), { isDestroyed: () => false });
});
it('isolates remote pages and blocks unapproved navigation, popups and requests', async () => {
  const done = openProviderLogin(provider, parent as BrowserWindow);
  await Promise.resolve();
  const win = state.windows[0];
  expect(win.options.webPreferences).toMatchObject({ session: state.lease.session, nodeIntegration: false, sandbox: true, contextIsolation: true });
  expect(win.options.webPreferences.preload).toBeUndefined();
  const event = { preventDefault: vi.fn() };
  win.webContents.emit('will-navigate', event, 'https://evil.test');
  expect(event.preventDefault).toHaveBeenCalled();
  const filter = state.lease.session.webRequest.onBeforeRequest.mock.calls[0][0];
  const callback = vi.fn(); filter({ url: 'https://evil.test/script.js' }, callback);
  expect(callback).toHaveBeenCalledWith({ cancel: true });
  expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://evil.test' })).toEqual({ action: 'deny' });
  win.destroy(); await done;
  expect(state.lease.release).toHaveBeenCalled();
  expect(state.lease.session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
});
it('reuses an open login task and closes on route reset', async () => {
  const done = openProviderLogin(provider, parent);
  expect(openProviderLogin(provider, parent)).toBe(done);
  await Promise.resolve(); controller.abort(); await done;
  expect(state.windows).toHaveLength(1);
  expect(state.windows[0].isDestroyed()).toBe(true);
});
it('allows Cloudflare challenge resources only inside the login window', async () => {
  const done = openProviderLogin(provider, parent);
  await Promise.resolve();
  const win = state.windows[0];
  const filter = state.lease.session.webRequest.onBeforeRequest.mock.calls[0][0];
  for (const resourceType of ['script', 'subFrame', 'xhr']) {
    const callback = vi.fn();
    filter({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js', resourceType, webContentsId: 17 }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: false });
  }
  for (const details of [
    { url: 'https://challenges.cloudflare.com/', resourceType: 'mainFrame', webContentsId: 17 },
    { url: 'https://challenges.cloudflare.com/', resourceType: 'script', webContentsId: 18 },
    { url: 'https://challenges.cloudflare.com.evil.test/', resourceType: 'mainFrame', webContentsId: 17 },
    { url: 'http://challenges.cloudflare.com/', resourceType: 'script', webContentsId: 17 },
  ]) {
    const callback = vi.fn(); filter(details, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  }
  const event = { preventDefault: vi.fn() };
  win.webContents.emit('will-redirect', event, 'https://challenges.cloudflare.com/', false, false);
  expect(event.preventDefault).not.toHaveBeenCalled();
  win.webContents.emit('will-navigate', event, 'https://challenges.cloudflare.com/');
  expect(event.preventDefault).toHaveBeenCalled();
  win.destroy(); await done;
});
it('closes with its owner', async () => {
  const done = openProviderLogin(provider, parent);
  await Promise.resolve(); parent.emit('closed'); await done;
  expect(state.windows[0].isDestroyed()).toBe(true);
});
it('permits HTTPS page dependencies only in the isolated login window, not top-level navigation', async () => {
  const done = openProviderLogin(provider, parent);
  await Promise.resolve();
  const filter = state.lease.session.webRequest.onBeforeRequest.mock.calls[0][0];
  for (const resourceType of ['stylesheet', 'image', 'font', 'script', 'xhr', 'mainFrame']) {
    const callback = vi.fn();
    filter({ url: 'https://cdn.test/asset', webContentsId: 17, resourceType }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: resourceType === 'mainFrame' });
  }
  const callback = vi.fn();
  filter({ url: 'https://cdn.test/asset', webContentsId: 18, resourceType: 'image' }, callback);
  expect(callback).toHaveBeenCalledWith({ cancel: true });
  state.windows[0].destroy(); await done;
});
it('rejects login before network access is configured', async () => {
  state.route = null;
  await expect(openProviderLogin(provider, parent)).rejects.toThrow('Save a connection');
  expect(state.windows).toHaveLength(0);
});
it('opens approved popup forms in the guarded window and preserves POST data', async () => {
  const done = openProviderLogin(provider, parent);
  await Promise.resolve();
  const win = state.windows[0];
  const popup = win.webContents.setWindowOpenHandler.mock.calls[0][0];
  const data = [{ type: 'rawData', bytes: Buffer.from('nm=test') }];
  expect(popup({ url: 'https://source.test/forum/tracker.php', postBody: { contentType: 'application/x-www-form-urlencoded', data } })).toEqual({ action: 'deny' });
  await new Promise(resolve => setImmediate(resolve));
  expect(win.loadURL).toHaveBeenLastCalledWith('https://source.test/forum/tracker.php', expect.objectContaining({ postData: data, extraHeaders: 'Content-Type: application/x-www-form-urlencoded\r\n' }));
  win.destroy(); await done;
});
