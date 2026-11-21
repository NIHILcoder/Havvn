import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

/** UI bridges belong to the current app shell's top frame, never another window. */
export function isAppUiSender(
  event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null | undefined,
): boolean {
  return !!window && !window.isDestroyed() && !!event.senderFrame
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

export function assertAppUiSender(
  event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null | undefined,
): void {
  if (!isAppUiSender(event, window)) throw new Error('Untrusted app request');
}

/** Hash routing does not navigate. Every document navigation would replace our UI. */
export function installAppNavigationPolicy(contents: WebContents, openExternal: (url: string) => void): void {
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    try {
      const target = new URL(url);
      if ((target.protocol === 'https:' || target.protocol === 'http:') && !target.username && !target.password) openExternal(target.href);
    } catch { /* Invalid links cannot navigate the privileged window. */ }
  });
  // Covers redirects from a future programmatic load as well as link navigation.
  contents.on('will-redirect', event => event.preventDefault());
}
