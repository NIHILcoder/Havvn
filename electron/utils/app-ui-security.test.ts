import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { assertAppUiSender, installAppNavigationPolicy } from './app-ui-security';

describe('privileged app UI boundary', () => {
  const mainFrame = {}, webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = (sender = webContents, senderFrame: object | null = mainFrame) => ({ sender, senderFrame }) as IpcMainInvokeEvent;
  it('accepts the current shell top frame', () => {
    expect(() => assertAppUiSender(event(), window)).not.toThrow();
  });
  it('rejects subframes, null frames, other windows and destroyed or missing owners', () => {
    for (const request of [event(webContents, {}), event(webContents, null), event({ mainFrame })]) {
      expect(() => assertAppUiSender(request, window)).toThrow('Untrusted');
    }
    expect(() => assertAppUiSender(event(), null)).toThrow('Untrusted');
    expect(() => assertAppUiSender(event(), { ...window, isDestroyed: () => true } as BrowserWindow)).toThrow('Untrusted');
  });
  it.each([
    'file:///C:/Downloads/hostile.html', 'file:///D:/reps/Havvn/Havvn/dist/renderer/other.html',
    'http://127.0.0.1:3000.evil.example/', 'http://127.0.0.1:30001/',
    'https://evil.example/', 'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)', 'about:blank', 'https://user:password@example.org/',
  ])('blocks document navigation to %s', url => {
    type Navigation = (event: { preventDefault(): void }, url: string) => void;
    const handlers = new Map<string, Navigation>();
    const contents = { on: (name: string, handler: Navigation) => handlers.set(name, handler) } as unknown as WebContents;
    const external = vi.fn(), navigation = { preventDefault: vi.fn() };
    installAppNavigationPolicy(contents, external);
    handlers.get('will-navigate')!(navigation, url);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('about:') || url.includes('password@')) expect(external).not.toHaveBeenCalled();
    const redirect = { preventDefault: vi.fn() };
    handlers.get('will-redirect')!(redirect, url);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
  });
});
