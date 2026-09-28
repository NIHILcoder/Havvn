import { BrowserWindow } from 'electron';
import { providerNetwork } from './provider-network';
import { ProviderNetworkError, httpNetworkError, networkError, providerUrl, type ProviderConnection } from '../../shared/provider-network';

/** HTML navigation for sources which accept a browser but reject background HTTP.
 * No preload, Node API, credential export, or automatic challenge solving.
 */
export async function readProviderPage(providerId: string, connection: ProviderConnection, target: string,
  origins: readonly string[], signal: AbortSignal, maxBytes = 4 * 1024 * 1024): Promise<{ body: Buffer; contentType: string; url: string }> {
  const initial = providerUrl(target, origins);
  const lease = await providerNetwork.acquireSession(providerId, connection);
  let page: BrowserWindow | undefined;
  try {
    if (signal.aborted || lease.signal.aborted) throw new ProviderNetworkError('cancelled');
    lease.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    lease.session.setPermissionCheckHandler(() => false);
    page = new BrowserWindow({ show: false, width: 1040, height: 760, webPreferences: {
      session: lease.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false,
      backgroundThrottling: false,
    } });
    const window = page;
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return await new Promise((resolve, reject) => {
      let settled = false;
      let status = 0;
      let redirects = 0;
      let reading = false;
      const finish = (error?: unknown, result?: { body: Buffer; contentType: string; url: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        lease.signal.removeEventListener('abort', abort);
        lease.session.removeListener('will-download', download);
        if (error) reject(networkError(error)); else resolve(result!);
      };
      const abort = () => finish(new ProviderNetworkError('cancelled'));
      const timer = setTimeout(() => finish(new ProviderNetworkError('timeout')), 12000);
      const download = (event: Electron.Event, _item: Electron.DownloadItem, owner: Electron.WebContents) => {
        if (owner === contents) { event.preventDefault(); finish(new ProviderNetworkError('invalid-response')); }
      };
      lease.session.on('will-download', download);
      signal.addEventListener('abort', abort, { once: true });
      lease.signal.addEventListener('abort', abort, { once: true });
      const guard = (event: Electron.Event, url: string) => {
        try {
          const next = providerUrl(url, origins);
          if (++redirects > 5 || (initial.protocol === 'https:' && next.protocol !== 'https:')) throw new ProviderNetworkError('redirect');
        } catch (error) { event.preventDefault(); finish(error); }
      };
      contents.on('will-redirect', (event, url, _inPlace, main) => { if (main) guard(event, url); });
      contents.on('will-navigate', guard);
      contents.on('did-navigate', (_event, _url, code) => { status = code; });
      contents.on('render-process-gone', () => finish(new ProviderNetworkError('network')));
      window.once('closed', abort);
      contents.on('dom-ready', () => {
        if (settled || reading) return;
        reading = true;
        // Fixed code in an isolated world. Never execute plugin/page-supplied JS.
        void contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
          const html = document.documentElement?.outerHTML || '';
          return { type: document.contentType, html: html.length <= ${maxBytes} ? html : null };
        })()` }]).then((document: { type: string; html: string | null }) => {
          if (settled) return;
          const url = providerUrl(contents.getURL(), origins).href;
          if (document.html === null) throw new ProviderNetworkError('too-large');
          if (/cf-chl-|challenge-platform|challenges.cloudflare.com\/turnstile/i.test(document.html) && status >= 400) throw new ProviderNetworkError('captcha', status);
          if (status < 200 || status >= 300) throw httpNetworkError(status);
          if (!['text/html', 'application/xhtml+xml'].includes(document.type)) throw new ProviderNetworkError('invalid-response');
          const body = Buffer.from(document.html, 'utf8');
          if (body.length > maxBytes) throw new ProviderNetworkError('too-large');
          finish(undefined, { body, contentType: 'text/html; charset=utf-8', url });
        }).catch(finish);
      });
      void window.loadURL(initial.href).catch(error => { if (!reading) finish(error); });
    });
  } finally {
    if (page && !page.isDestroyed()) page.destroy();
    lease.release();
  }
}
