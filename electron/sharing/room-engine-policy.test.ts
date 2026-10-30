import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installRoomEnginePolicy, installUiPermissionPolicy, ROOM_ENGINE_CSP } from './room-engine-policy';

const page = 'file:///D:/app/room-engine.html';
function fixture() {
  let check!: Parameters<Session['setPermissionCheckHandler']>[0];
  let request!: Parameters<Session['setPermissionRequestHandler']>[0];
  let before!: Parameters<Session['webRequest']['onBeforeRequest']>[0];
  let headers!: Parameters<Session['webRequest']['onHeadersReceived']>[0];
  let open!: Parameters<WebContents['setWindowOpenHandler']>[0];
  const session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: (cb: typeof check) => { check = cb; },
    setPermissionRequestHandler: (cb: typeof request) => { request = cb; },
    webRequest: { onBeforeRequest: (cb: typeof before) => { before = cb; }, onHeadersReceived: (cb: typeof headers) => { headers = cb; } },
  });
  const contents = Object.assign(new EventEmitter(), { id: 9, session, getURL: () => page, setWindowOpenHandler: (cb: typeof open) => { open = cb; } });
  let destroyed = false;
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed });
  let capture: { audio: boolean; video: boolean; speaker?: boolean } = { audio: false, video: false };
  installRoomEnginePolicy(win as unknown as BrowserWindow, page, () => capture);
  return {
    win, contents, session, setCapture: (audio: boolean, video: boolean) => { capture = { audio, video }; },
    setSpeaker: (speaker: boolean) => { capture = { ...capture, speaker }; },
    destroy: () => { destroyed = true; win.emit('closed'); },
    check: (permission: string, changes = {}) => check!(contents as unknown as WebContents, permission, 'file://', { isMainFrame: true, requestingUrl: page, mediaType: 'audio', ...changes }),
    request: (permission: string, changes = {}) => {
      const callback = vi.fn();
      request!(contents as unknown as WebContents, permission, callback, { isMainFrame: true, requestingUrl: page, mediaTypes: ['audio'], ...changes });
      return callback.mock.calls[0][0];
    },
    resource: (url: string, resourceType: string, webContentsId = 9) => {
      const callback = vi.fn(); before!({ url, resourceType, webContentsId } as Electron.OnBeforeRequestListenerDetails, callback);
      return callback.mock.calls[0][0].cancel;
    },
    csp: () => { const callback = vi.fn(); headers!({ responseHeaders: {} } as Electron.OnHeadersReceivedListenerDetails, callback); return callback.mock.calls[0][0].responseHeaders; },
    open: () => open!({} as Electron.HandlerDetails),
  };
}

describe('room engine boundary', () => {
  it('permits an explicit output test without microphone or display permission', () => {
    const f = fixture(); expect(f.check('speaker-selection')).toBe(false);
    f.setSpeaker(true); expect(f.check('speaker-selection')).toBe(true); expect(f.request('speaker-selection')).toBe(true);
    expect(f.check('media')).toBe(false); expect(f.request('media')).toBe(false); expect(f.request('display-capture')).toBe(false);
    expect(f.request('speaker-selection', { isMainFrame: false })).toBe(false);
    f.setSpeaker(false); expect(f.check('speaker-selection')).toBe(false);
  });
  it('ships the same CSP in the immutable host and the session policy', () => {
    const html = readFileSync(new URL('./room-engine.html', import.meta.url), 'utf8');
    expect(html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1]).toBe(ROOM_ENGINE_CSP);
  });
  it('grants only the requested capture type during an explicit operation', () => {
    const f = fixture();
    expect(f.check('media')).toBe(false); expect(f.request('media')).toBe(false);
    f.setCapture(true, false);
    expect(f.check('media')).toBe(true); expect(f.request('media')).toBe(true);
    expect(f.check('media', { mediaType: 'video' })).toBe(false);
    expect(f.request('media', { mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(f.request('media', { mediaTypes: [] })).toBe(false);
    expect(f.check('geolocation')).toBe(false); expect(f.request('notifications')).toBe(false);
    f.setCapture(false, true);
    expect(f.request('media', { mediaTypes: ['video'] })).toBe(true);
    expect(f.check('media')).toBe(false);
  });

  it('rejects another origin, subframe, unknown media type and a closed window', () => {
    const f = fixture(); f.setCapture(true, true);
    for (const changes of [{ requestingUrl: 'https://example.com/' }, { isMainFrame: false }, { mediaType: 'unknown' }]) expect(f.check('media', changes)).toBe(false);
    expect(f.request('media', { isMainFrame: false })).toBe(false);
    f.destroy(); expect(f.check('media')).toBe(false); expect(f.session.listenerCount('will-download')).toBe(0);
  });

  it('allows legacy untyped desktop requests only during an explicit screen operation', () => {
    const f = fixture();
    const legacy = { mediaTypes: [] };
    expect(f.request('media', legacy)).toBe(false);
    f.setCapture(true, false);
    expect(f.request('media', legacy)).toBe(false);
    f.setCapture(false, true);
    expect(f.request('media', legacy)).toBe(true);
    expect(f.request('media', { mediaTypes: undefined })).toBe(false);
    expect(f.request('media', { mediaTypes: ['unknown'] })).toBe(false);
    for (const change of [{ requestingUrl: 'https://example.com/' }, { isMainFrame: false }]) {
      expect(f.request('media', { ...legacy, ...change })).toBe(false);
    }
    f.setCapture(true, false);
    expect(f.request('media', legacy)).toBe(false);
    expect(f.request('media')).toBe(true);
  });

  it('handles distinct display permissions without authorizing idle or microphone-only capture', () => {
    const f = fixture();
    const video = { mediaType: 'video', mediaTypes: ['video'] };
    expect(f.check('display-capture', video)).toBe(false);
    expect(f.request('display-capture', video)).toBe(false);
    f.setCapture(true, false);
    expect(f.request('display-capture', video)).toBe(false);
    f.setCapture(false, true);
    expect(f.check('display-capture', video)).toBe(true);
    expect(f.check('display-capture', { mediaType: undefined })).toBe(true);
    expect(f.request('display-capture', video)).toBe(true);
    expect(f.request('display-capture', { mediaTypes: [] })).toBe(true);
    expect(f.check('display-capture', { mediaType: 'audio' })).toBe(false);
    expect(f.check('display-capture', { mediaType: 'unknown' })).toBe(false);
    expect(f.request('display-capture', { mediaTypes: ['video', 'audio'] })).toBe(false);
    expect(f.request('display-capture', { mediaTypes: ['unknown'] })).toBe(false);
    f.setCapture(true, true);
    expect(f.request('display-capture', { mediaTypes: ['video', 'audio'] })).toBe(true);
    for (const change of [{ requestingUrl: 'https://example.com/' }, { isMainFrame: false }]) {
      expect(f.request('display-capture', { ...video, ...change })).toBe(false);
      expect(f.check('display-capture', { ...video, ...change })).toBe(false);
    }
    f.setCapture(true, false);
    expect(f.request('display-capture', video)).toBe(false);
    f.setCapture(true, true); f.destroy();
    expect(f.request('display-capture', video)).toBe(false);
    expect(f.request('media', { mediaTypes: [] })).toBe(false);
  });

  it('allows the packaged host, networking and blob worklets; blocks other documents and scripts', () => {
    const f = fixture();
    expect(f.resource(page, 'mainFrame')).toBe(false);
    expect(f.resource('wss://tracker.example/', 'webSocket')).toBe(false);
    expect(f.resource('https://tracker.example/data', 'xhr')).toBe(false);
    expect(f.resource('blob:file:///processor', 'script', -1)).toBe(false);
    for (const [url, type] of [['https://example.com/', 'mainFrame'], [page, 'subFrame'], ['https://example.com/a.js', 'script'], ['file:///D:/private.txt', 'xhr']]) expect(f.resource(url, type)).toBe(true);
    expect(f.resource('https://tracker.example/data', 'xhr', 42)).toBe(true);
    expect(f.csp()['Content-Security-Policy']).toEqual([ROOM_ENGINE_CSP]);
    expect(f.open().action).toBe('deny');
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
      const preventDefault = vi.fn(); f.contents.emit(event, { preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
    }
    const preventDefault = vi.fn(); f.session.emit('will-download', { preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('limits the visible app session to UI capabilities', () => {
    const f = fixture();
    installUiPermissionPolicy(f.session as unknown as Session, (wc, url) => wc === f.contents as unknown && url === page);
    expect(f.check('fullscreen')).toBe(true); expect(f.request('speaker-selection')).toBe(true);
    for (const permission of ['media', 'display-capture', 'geolocation', 'notifications', 'midiSysex']) expect(f.check(permission)).toBe(false);
    expect(f.request('display-capture', { mediaTypes: ['video'] })).toBe(false);
    expect(f.request('fullscreen', { requestingUrl: 'https://example.com/' })).toBe(false);
    expect(f.check('fullscreen', { isMainFrame: false })).toBe(false);
  });
});
