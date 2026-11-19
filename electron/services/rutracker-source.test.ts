import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), remember: vi.fn(), route: null as any, providers: [] as any[], temp: '' }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => state.temp } }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }, httpFetch: vi.fn(), httpFetchText: vi.fn() }));
vi.mock('../db/store', () => ({ getSearchProviders: async () => state.providers }));
vi.mock('./provider-browser', () => ({ readProviderPage: state.read }));
vi.mock('./provider-network', () => ({ providerNetwork: { request: state.request, acquireSession: async () => ({ signal: new AbortController().signal, release: vi.fn() }) } }));
vi.mock('./provider-network-store', () => ({ getProviderRoute: () => state.route, rememberProviderMirror: state.remember }));
import { SearchService } from './search-service';
import { searchRuTracker } from './rutracker-source';
import { ProviderNetworkError } from '../../shared/provider-network';
import type { SearchProgress } from '../../shared/types';
const provider = { id: 'rt', type: 'rutracker' as const, name: 'RuTracker', url: 'https://main.test/forum', enabled: true };
const page = (id: number, more = false) => `<table id="tor-tbl"><tr id="trs-tr-${id}"><td class="t-title"><a href="viewtopic.php?t=${id}">Фильм</a></td><td class="tor-size" data-ts_text="500">500 B</td><td class="seedmed">4</td></tr></table>${more ? '<a href="tracker.php?nm=x&amp;start=50">2</a>' : ''}`;
const response = (html: string, base = 'https://main.test/forum/tracker.php') => ({ body: Buffer.from(html), contentType: 'text/html; charset=utf-8', url: base });
beforeEach(() => {
  state.temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-native-search-'));
  vi.resetAllMocks(); state.providers = [{ ...provider }];
  state.route = { connection: { mode: 'system' }, origins: ['https://mirror.test'], mirrors: ['https://mirror.test/forum'] };
});
afterEach(() => {
  expect(path.dirname(state.temp)).toBe(fs.realpathSync(os.tmpdir())); expect(path.basename(state.temp)).toMatch(/^havvn-native-search-/);
  fs.rmSync(state.temp, { recursive: true, force: true });
});
async function collect(start: (emit: (progress: SearchProgress) => void) => Promise<unknown>) {
  const messages: SearchProgress[] = [];
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  await start(progress => { messages.push(progress); if (progress.done) finish(); }); await done;
  return messages;
}
it('returns rows after a single page request, using the configured browser session without Python', async () => {
  state.read.mockResolvedValue(response(page(1, true)));
  const service = new SearchService(); const messages = await collect(emit => service.start('Фильм', undefined, emit));
  const result = messages.find(message => message.results?.length)!.results![0];
  expect(result.deferredSource).toBe('rt:1'); expect(result.sourceRefs).toHaveLength(1); expect(result.magnetUri).toBeUndefined();
  expect(state.read).toHaveBeenCalledOnce(); expect(state.read.mock.calls[0][2]).toContain('nm=%D4%E8%EB%FC%EC&start=0');
  expect(state.read.mock.calls[0][1]).toEqual(state.route.connection); expect(state.request).not.toHaveBeenCalled();
  expect(messages.find(message => message.stat)?.stat?.nextPage).toBeTruthy();
  const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
  state.read.mockResolvedValueOnce(response(`<a href="${magnet}&amp;dn=Film">Magnet</a>`, 'https://main.test/forum/viewtopic.php?t=1'));
  expect(await service.resolveSource(result.sourceRefs!)).toEqual({ sourceType: 'magnet', sourceUri: magnet + '&dn=Film' });
  expect(state.read.mock.calls[1][2]).toBe('https://main.test/forum/viewtopic.php?t=1');
  await service.resolveSource(result.sourceRefs!); expect(state.read).toHaveBeenCalledTimes(2);
});

it('loads release content only from registered topics and requests structured extraction through the same session', async () => {
  state.read.mockResolvedValueOnce(response(page(7)));
  const service = new SearchService(), messages = await collect(emit => service.start('query', undefined, emit));
  const refs = messages.find(message => message.results?.length)!.results![0].sourceRefs!;
  expect(state.read).toHaveBeenCalledOnce();
  state.read.mockResolvedValueOnce({ ...response('<a href="login.php?logout=1">Logout</a>', 'https://main.test/forum/viewtopic.php?t=7'),
    details: { available: true, title: 'Full title', blocks: [{ kind: 'paragraph', text: 'Synopsis' }], images: [], truncated: false } });
  expect(await service.releaseDetails(refs, 'preview-one')).toMatchObject({ title: 'Full title', blocks: [{ text: 'Synopsis' }], supported: true });
  expect(state.read.mock.calls[1][1]).toEqual(state.route.connection); expect(state.read.mock.calls[1][6]).toBe(true);
  await service.releaseDetails(refs, 'preview-two'); expect(state.read).toHaveBeenCalledTimes(2);
  await expect(service.releaseDetails(['https://arbitrary.test/topic'], 'preview-three')).rejects.toThrow('expired');
  state.providers[0].enabled = false; await expect(service.releaseDetails(refs, 'preview-four')).rejects.toThrow('expired');
  expect(state.read).toHaveBeenCalledTimes(2);
});

it('does not start a preview if it was cancelled while provider configuration was loading', async () => {
  const service = new SearchService(), controller = new AbortController(); controller.abort();
  await expect(service.releaseDetails(['unregistered'], 'preview-cancelled', undefined, false, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect(state.read).not.toHaveBeenCalled();
});
it('loads only the next native page and keeps the initial cache independent', async () => {
  state.read.mockResolvedValueOnce(response(page(1, true))).mockResolvedValueOnce(response(page(2)));
  const service = new SearchService(); const first = await collect(emit => service.start('query', undefined, emit));
  const token = first.find(message => message.stat)?.stat?.nextPage;
  if (!token) throw new Error('Expected a capability for the next results page');
  const second = await collect(emit => service.more(token, emit));
  expect(second.find(message => message.results?.length)?.results![0].deferredSource).toBe('rt:2');
  expect(state.read.mock.calls[1][2]).toContain('&start=50');
  expect(second.find(message => message.stat)?.stat?.nextPage).toBeUndefined();
  const replay = await collect(emit => service.start('query', undefined, emit));
  expect(replay.find(message => message.results?.length)?.results![0].deferredSource).toBe('rt:1');
  expect(state.read).toHaveBeenCalledTimes(2);
  service.clearResultCache(); await expect(service.more(token, () => {})).rejects.toThrow();
});
it('replays separate source batches when the built-in and another provider share a display name', async () => {
  state.providers.push({ id: 'other', type: 'custom', name: 'RuTracker', url: 'https://main.test/search', enabled: true });
  state.read.mockResolvedValue(response(page(1)));
  state.request.mockResolvedValue({ text: () => JSON.stringify({ results: [{ title: 'Other', magnetUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }] }) });
  const service = new SearchService();
  await collect(emit => service.start('query', undefined, emit));
  const replay = await collect(emit => service.start('query', undefined, emit));
  expect(replay.filter(message => message.stat).map(message => [message.stat!.providerId, message.results!.map(row => row.title)]).sort()).toEqual([['other', ['Other']], ['rt', ['Фильм']]]);
});
it('retries network errors on configured mirrors and resolves the selected topic on the working origin', async () => {
  state.read.mockRejectedValueOnce(new ProviderNetworkError('dns')).mockResolvedValueOnce(response(page(7), 'https://mirror.test/forum/tracker.php'));
  const service = new SearchService(); const messages = await collect(emit => service.start('query', undefined, emit));
  const result = messages.find(message => message.results?.length)!.results![0];
  expect(result.detailsUrl).toBe('https://mirror.test/forum/viewtopic.php?t=7');
  expect(state.remember).toHaveBeenCalledWith('rt', 'https://mirror.test/forum');
});
it.each(['auth', 'captcha'] as const)('does not retry %s on every mirror and emits an actionable diagnostic', async code => {
  state.read.mockRejectedValue(new ProviderNetworkError(code));
  const messages = await collect(emit => new SearchService().start('query', undefined, emit));
  expect(messages.find(message => message.stat)?.stat).toMatchObject({ state: 'failed', errorCode: code });
  expect(state.read).toHaveBeenCalledOnce();
});
it('cancels the browser request when a search is abandoned', async () => {
  state.read.mockImplementation((_id, _connection, _url, _origins, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new ProviderNetworkError('cancelled')), { once: true });
  }));
  const service = new SearchService(); let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  const run = await service.start('query', undefined, progress => { if (progress.done) finish(); });
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce()); service.cancel(run.searchId); await done;
  expect((state.read.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
});
it('rejects forged, expired and disabled-provider page capabilities without sending a request', async () => {
  const service = new SearchService(); await expect(service.more('https://evil.test', () => {})).rejects.toThrow();
  state.read.mockResolvedValue(response(page(1, true)));
  const messages = await collect(emit => service.start('query', undefined, emit));
  const token = messages.find(message => message.stat)?.stat?.nextPage;
  if (!token) throw new Error('Expected a capability for the next results page');
  state.providers[0].enabled = false; await expect(service.more(token, () => {})).rejects.toThrow();
  state.providers[0].enabled = true;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  try { await expect(service.more(token, () => {})).rejects.toThrow(); } finally { clock.mockRestore(); }
  expect(state.read).toHaveBeenCalledOnce();
});
it('never falls back to a direct or Python connection when the shared route is missing', async () => {
  state.route = null; await expect(searchRuTracker(provider, 'query')).rejects.toMatchObject({ code: 'auth' });
  expect(state.read).not.toHaveBeenCalled(); expect(state.request).not.toHaveBeenCalled();
});
it('downloads protected torrent metadata through the same route when a topic has no magnet', async () => {
  const bytes = Buffer.from('d4:infod6:lengthi0e4:name4:test12:piece lengthi16384e6:pieces0:ee');
  state.read.mockResolvedValueOnce(response(page(8))).mockResolvedValueOnce(response('<a href="login.php?logout=1">Logout</a>', 'https://main.test/forum/viewtopic.php?t=8'));
  state.request.mockResolvedValue({ body: bytes });
  const service = new SearchService(), messages = await collect(emit => service.start('query', undefined, emit));
  const refs = messages.find(message => message.results?.length)!.results![0].sourceRefs!;
  const result = await service.resolveSource(refs);
  expect(result.sourceType).toBe('torrent_file'); expect(fs.readFileSync(result.sourceUri)).toEqual(bytes);
  expect(state.request.mock.calls[0].slice(0, 3)).toEqual(['rt', state.route.connection, 'https://main.test/forum/dl.php?t=8']);
  service.clearResultCache(); await expect(service.resolveSource(refs)).rejects.toThrow(/expired/);
});
it('reports expired topic/download sessions rather than exposing a login page as a torrent', async () => {
  state.read.mockResolvedValueOnce(response(page(1))).mockResolvedValueOnce(response('<input name="login_username"><input name="login_password">', 'https://main.test/forum/login.php'));
  const service = new SearchService(), messages = await collect(emit => service.start('query', undefined, emit));
  await expect(service.resolveSource(messages.find(message => message.results?.length)!.results![0].sourceRefs!)).rejects.toMatchObject({ code: 'auth' });
  expect(state.request).not.toHaveBeenCalled();
  state.read.mockResolvedValueOnce(response('<a href="login.php?logout=1">Logout</a>', 'https://main.test/forum/viewtopic.php?t=1'));
  state.request.mockResolvedValue({ body: Buffer.from('<input name="login_username"><input name="login_password">') });
  await expect(service.resolveSource(messages.find(message => message.results?.length)!.results![0].sourceRefs!)).rejects.toMatchObject({ code: 'auth' });
});
