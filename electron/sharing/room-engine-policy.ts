import type { BrowserWindow, Session, WebContents } from 'electron';

export const ROOM_ENGINE_PARTITION = 'persist:havvn-room-engine';
export const ROOM_ENGINE_CSP = [
  "default-src 'none'", "script-src 'self' blob: 'wasm-unsafe-eval'", "worker-src blob:",
  'connect-src https: http: wss: ws:', 'media-src blob:', "object-src 'none'", "frame-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join('; ');

function samePage(url: string | undefined, page: string): boolean {
  if (!url) return false;
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href === page; }
  catch { return false; }
}

/** The preload keeps Node access; the document is an immutable, inert packaged host. */
export function installRoomEnginePolicy(win: BrowserWindow, page: string, access: () => { audio: boolean; video: boolean }): void {
  const contents = win.webContents, ses = contents.session;
  const trusted = (wc: WebContents | null, url?: string, mainFrame?: boolean) =>
    wc === contents && !win.isDestroyed() && mainFrame === true && samePage(url, page) && samePage(contents.getURL(), page);
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (!trusted(wc, details.requestingUrl, details.isMainFrame)) return false;
    const grant = access();
    if (permission === 'speaker-selection') return grant.audio;
    if (permission !== 'media') return false;
    return details.mediaType === 'audio' ? grant.audio : details.mediaType === 'video' ? grant.video : false;
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!trusted(wc, details.requestingUrl, details.isMainFrame)) { callback(false); return; }
    const grant = access();
    if (permission === 'speaker-selection') { callback(grant.audio); return; }
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(permission === 'media' && !!types?.length && types.every((type) => type === 'audio' ? grant.audio : type === 'video' && grant.video));
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  const denyDownload = (event: { preventDefault(): void }) => event.preventDefault();
  ses.on('will-download', denyDownload);
  win.once('closed', () => ses.removeListener('will-download', denyDownload));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const own = details.webContentsId === contents.id && !win.isDestroyed();
    const host = own && details.resourceType === 'mainFrame' && details.url === page;
    const network = own && ['xhr', 'webSocket'].includes(details.resourceType) && /^https?:|^wss?:/.test(details.url);
    // Chromium worklet requests can omit webContentsId. This isolated session
    // allows blob modules only, while remote scripts and documents stay blocked.
    const worklet = !win.isDestroyed() && (own || details.webContentsId === -1 || details.webContentsId === undefined)
      && details.resourceType === 'script' && details.url.startsWith('blob:');
    callback({ cancel: !(host || network || worklet) });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [ROOM_ENGINE_CSP] } });
  });
}

/** Visible app windows need UI capabilities, never a blanket device grant. */
export function installUiPermissionPolicy(ses: Session, trusted: (wc: WebContents | null, url: string) => boolean): void {
  const allowed = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'screen-wake-lock', 'speaker-selection']);
  ses.setPermissionCheckHandler((wc, permission, _origin, details) =>
    details.isMainFrame === true && allowed.has(permission) && trusted(wc, details.requestingUrl || ''));
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(details.isMainFrame === true && allowed.has(permission) && trusted(wc, details.requestingUrl)));
}
