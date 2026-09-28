import { BrowserWindow } from 'electron';
import { providerNetwork } from './provider-network';
import { getProviderRoute } from './provider-network-store';
import { providerUrl } from '../../shared/provider-network';
import type { SearchProvider } from '../../shared/types';

const windows = new Map<string, Promise<void>>();

/** Remote pages have no preload or access to Havvn's renderer API. */
export function openProviderLogin(provider: SearchProvider, parent: BrowserWindow): Promise<void> {
  const existing = windows.get(provider.id);
  if (existing) return existing;
  const task = open(provider, parent).finally(() => windows.delete(provider.id));
  windows.set(provider.id, task);
  return task;
}
async function open(provider: SearchProvider, parent: BrowserWindow): Promise<void> {
  const route = getProviderRoute(provider.id);
  if (!route) throw new Error('Save a connection before signing in');
  const target = route.mirrors[0] || (provider.type !== 'script' ? new URL(provider.url).origin : route.origins[0]);
  if (!target) throw new Error('Configure a source mirror before signing in');
  const origins = [...route.origins];
  if (provider.type !== 'script') origins.push(new URL(provider.url).origin);
  const url = providerUrl(target, origins);
  const lease = await providerNetwork.acquireSession(provider.id, route.connection);
  if (parent.isDestroyed() || lease.signal.aborted) { lease.release(); return; }
  const sourceSession = lease.session;
  sourceSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sourceSession.setPermissionCheckHandler(() => false);
  const login = new BrowserWindow({ parent, width: 1040, height: 760, title: provider.name,
    webPreferences: { session: sourceSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  login.removeMenu();
  const allowed = (value: string) => { try { providerUrl(value, origins); return true; } catch { return false; } };
  // Turnstile needs its scripts and child frame even when the source itself is
  // the only configured origin. This exception belongs to the login window,
  // not the source's HTTP/Python permissions or top-level navigation.
  const challenge = (value: string) => {
    try { return new URL(value).origin === 'https://challenges.cloudflare.com'; } catch { return false; }
  };
  const guard = (event: Electron.Event, value: string) => { if (!allowed(value)) event.preventDefault(); };
  const pageResource = (value: string, type: string) => {
    // A normal site may host its UI scripts and frames on a separate CDN.
    // Browser CORS and the site's CSP still apply inside this isolated window.
    if (!['stylesheet', 'image', 'font', 'script', 'xhr', 'subFrame', 'other', 'media'].includes(type)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    } catch { return false; }
  };
  login.webContents.on('will-navigate', guard);
  login.webContents.on('will-redirect', (event, value, _inPlace, isMainFrame) => {
    if (isMainFrame === false && pageResource(value, 'subFrame')) return;
    guard(event, value);
  });
  sourceSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(allowed(details.url) || (
    details.webContentsId === login.webContents.id && details.resourceType !== 'mainFrame' && (
      challenge(details.url) || pageResource(details.url, details.resourceType)
    )
  )) }));
  login.webContents.setWindowOpenHandler(details => {
    // Keep same-source target=_blank links/forms usable without creating an
    // unguarded second window. Preserve POST bodies used by search/login forms.
    if (allowed(details.url)) {
      const post = details.postBody;
      const contentType = post?.contentType === 'multipart/form-data' && post.boundary
        ? `${post.contentType}; boundary=${post.boundary}` : post?.contentType;
      setImmediate(() => {
        if (login.isDestroyed()) return;
        void login.loadURL(details.url, {
          httpReferrer: details.referrer,
          ...(post ? { postData: post.data, extraHeaders: `Content-Type: ${contentType}\r\n` } : {}),
        }).catch(() => { /* loadURL shows the navigation failure in this window. */ });
      });
    }
    return { action: 'deny' };
  });
  const preventDownload = (event: Electron.Event) => event.preventDefault();
  sourceSession.on('will-download', preventDownload);
  const destroy = () => { if (!login.isDestroyed()) login.destroy(); };
  lease.signal.addEventListener('abort', destroy, { once: true });
  parent.once('closed', destroy);
  try {
    await new Promise<void>((resolve, reject) => {
      login.once('closed', resolve);
      void login.loadURL(url.href).catch(() => { reject(new Error('Unable to open source login page')); destroy(); });
    });
    await sourceSession.cookies.flushStore();
  } finally {
    destroy();
    sourceSession.webRequest.onBeforeRequest(null);
    sourceSession.removeListener('will-download', preventDownload);
    parent.removeListener('closed', destroy);
    lease.signal.removeEventListener('abort', destroy);
    lease.release();
  }
}
