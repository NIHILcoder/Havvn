import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ request: vi.fn(), remember: vi.fn(), providers: [] as any[], route: null as any, temp: '' }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => state.temp } }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }, httpFetch: vi.fn(), httpFetchText: vi.fn() }));
vi.mock('../db/store', () => ({ getSearchProviders: async () => state.providers }));
vi.mock('./provider-network', () => ({ providerNetwork: { request: state.request, acquireSession: async () => ({ signal: new AbortController().signal, release: vi.fn() }) } }));
vi.mock('./provider-network-store', () => ({ getProviderRoute: () => state.route, rememberProviderMirror: state.remember }));
import { SearchService } from './search-service';
import { mergeResults } from '../../shared/search-dedupe';
import { ProviderNetworkError } from '../../shared/provider-network';
const torrent = Buffer.from('d4:infod6:lengthi0e4:name4:test12:piece lengthi16384e6:pieces0:ee');
beforeEach(() => {
  vi.resetAllMocks();
  state.temp = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-search-test-'));
  state.providers = [{ id: 'source-a', name: 'Example', type: 'custom', enabled: true, url: 'https://site.test/search?q={query}' }];
  state.route = { connection: { mode: 'proxy', protocol: 'http', host: 'localhost', port: 8888 }, origins: [], mirrors: [] };
});
afterEach(() => fs.rmSync(state.temp, { recursive: true, force: true }));
async function search(service: SearchService) {
  const results: any[] = [];
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  await service.start('example', undefined, progress => {
    if (progress.results) results.push(...progress.results);
    if (progress.done) done();
  });
  await finished;
  return results;
}
function searchResponse() {
  return { text: () => JSON.stringify({ results: [{ title: 'Example', torrentUrl: 'https://site.test/private.torrent', size: 123, seeds: 1 }] }) };
}

describe('search source network integration', () => {
  it('stamps source receipt times in main, keeps cache age and sanitizes optional media reports', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
      state.request.mockResolvedValue({ text: () => JSON.stringify({ results: [{ title: 'Film', torrentUrl: '/file.torrent', checkedAt: 1,
        media: { audioLanguages: ['RUS', 'bad'], subtitleLanguages: ['en'], hasSubtitles: true, unsafe: '<script>' } }] }) });
      const service = new SearchService();
      const [first] = await search(service);
      expect(first.checkedAt).toBe(1700000000000);
      expect(first.media).toEqual({ audioLanguages: ['ru'], subtitleLanguages: ['en'], hasSubtitles: true });
      clock.mockReturnValue(1700000005000);
      const [cached] = await search(service);
      expect(cached.checkedAt).toBe(first.checkedAt);
      expect(state.request).toHaveBeenCalledOnce();
      service.clearResultCache();
      const [fresh] = await search(service);
      expect(fresh.checkedAt).toBe(1700000005000);
    } finally { clock.mockRestore(); }
  });
  it('retrieves torrent metadata on the search source route and stages a valid local file', async () => {
    state.request.mockResolvedValueOnce(searchResponse()).mockResolvedValueOnce({ body: torrent });
    const service = new SearchService();
    const [result] = await search(service);
    expect(result.torrentUrl).toBeUndefined();
    expect(result.historyKeys).toHaveLength(1);
    expect(service.historyKeysForSources(result.sourceRefs)).toEqual(result.historyKeys);
    const resolved = await service.resolveSource(result.sourceRefs);
    expect(resolved.sourceType).toBe('torrent_file');
    expect(fs.readFileSync(resolved.sourceUri).equals(torrent)).toBe(true);
    expect(state.request).toHaveBeenNthCalledWith(2, 'source-a', state.route.connection, 'https://site.test/private.torrent', expect.objectContaining({ allowedOrigins: ['https://site.test'] }));
  });
  it('rejects expired references and a login page returned as torrent metadata', async () => {
    const service = new SearchService();
    await expect(service.resolveSource(['unknown'])).rejects.toThrow('expired');
    state.request.mockResolvedValueOnce(searchResponse()).mockResolvedValueOnce({ body: Buffer.from('<html>Login</html>') });
    const [result] = await search(service);
    await expect(service.resolveSource(result.sourceRefs)).rejects.toThrow('metadata');
    expect(fs.existsSync(path.join(state.temp, 'havvn-search-torrents'))).toBe(false);
  });
  it('invalidates cached results when network settings change', async () => {
    state.request.mockResolvedValue(searchResponse());
    const service = new SearchService();
    await search(service); await search(service);
    expect(state.request).toHaveBeenCalledTimes(1);
    service.clearResultCache();
    await search(service);
    expect(state.request).toHaveBeenCalledTimes(2);
  });
  it('preserves source references when merging duplicate results without mutating old state', () => {
    const base = { title: 'Same', size: 123, seeds: 1, leechers: 0, infoHash: 'hash', provider: 'one', sourceRefs: ['one'], historyKeys: ['a'.repeat(64)] };
    const first = mergeResults([], [base]);
    const merged = mergeResults(first, [{ ...base, provider: 'two', sourceRefs: ['two'], historyKeys: ['b'.repeat(64)] }]);
    expect(merged[0].sourceRefs).toEqual(['one', 'two']);
    expect(first[0].sourceRefs).toEqual(['one']);
    expect(merged[0].historyKeys).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(first[0].historyKeys).toEqual(['a'.repeat(64)]);
  });
  it('uses stable history fingerprints across fresh searches instead of temporary capabilities', async () => {
    state.request.mockResolvedValue(searchResponse());
    const service = new SearchService();
    const [first] = await search(service);
    service.clearResultCache();
    const [second] = await search(service);
    expect(second.sourceRefs).not.toEqual(first.sourceRefs);
    expect(second.historyKeys).toEqual(first.historyKeys);
    expect(service.historyKeysForSources(['forged-fingerprint'])).toEqual([]);
    expect(() => service.historyKeysForSources('bad' as unknown as string[])).toThrow('Invalid');
  });
  it('searches a mirror and retrieves its download on another alias after it goes offline', async () => {
    state.route.mirrors = ['https://copy.test']; state.route.origins = ['https://copy.test'];
    state.request.mockRejectedValueOnce(new ProviderNetworkError('dns')).mockResolvedValueOnce({ text: () => JSON.stringify({ results: [{ title: 'Example', torrentUrl: '/private.torrent', detailsUrl: 'https://site.test/topic?id=1' }] }) });
    const service = new SearchService(); const [result] = await search(service);
    expect(result.detailsUrl).toBe('https://copy.test/topic?id=1'); expect(result.torrentUrl).toBeUndefined();
    expect(state.remember).toHaveBeenCalledWith('source-a', 'https://copy.test');
    state.route.lastWorkingMirror = 'https://copy.test';
    state.request.mockRejectedValueOnce(new ProviderNetworkError('network')).mockResolvedValueOnce({ body: torrent });
    const resolved = await service.resolveSource(result.sourceRefs);
    expect(fs.readFileSync(resolved.sourceUri)).toEqual(torrent);
    expect(state.request.mock.calls.slice(2).map(c => c[2])).toEqual(['https://copy.test/private.torrent', 'https://site.test/private.torrent']);
    expect(state.remember).toHaveBeenLastCalledWith('source-a', null);
  });
  it.each(['jackett', 'torznab'])('keeps %s API paths, keys and download context under a new service prefix', async type => {
    state.providers[0] = { ...state.providers[0], type, url: 'https://site.test/service', apiKey: 'secret&key' };
    state.route.mirrors = ['https://copy.test/new-service']; state.route.origins = ['https://copy.test'];
    const output = type === 'jackett' ? JSON.stringify({ Results: [{ Title: 'Example', Link: 'https://site.test/service/download?id=1', Size: 123 }] }) : '<rss><channel><item><title>Example</title><link>https://site.test/service/download?id=1</link></item></channel></rss>';
    state.request.mockRejectedValueOnce(new ProviderNetworkError('server', 503)).mockResolvedValueOnce({ text: () => output });
    const service = new SearchService(); const [result] = await search(service);
    const request = new URL(state.request.mock.calls[1][2]);
    expect(request.pathname).toBe(type === 'jackett' ? '/new-service/api/v2.0/indexers/all/results' : '/new-service/api');
    expect(request.searchParams.get('apikey')).toBe('secret&key');
    expect(request.searchParams.get(type === 'jackett' ? 'Query' : 'q')).toBe('example');
    state.route.lastWorkingMirror = 'https://copy.test/new-service';
    state.request.mockResolvedValueOnce({ body: torrent });
    await service.resolveSource(result.sourceRefs);
    expect(state.request.mock.calls[2][2]).toBe('https://copy.test/new-service/download?id=1');
  });
  it('tests Torznab capabilities on a mirror, including an empty category list', async () => {
    state.providers[0] = { ...state.providers[0], type: 'torznab', url: 'https://site.test/service' };
    state.route.mirrors = ['https://copy.test/root']; state.route.origins = ['https://copy.test'];
    state.request.mockRejectedValueOnce(new ProviderNetworkError('dns')).mockResolvedValueOnce({ text: () => '<caps><searching><search available="yes"/></searching><categories/></caps>' });
    expect((await new SearchService().testProvider('source-a')).success).toBe(true);
    expect(new URL(state.request.mock.calls[1][2]).pathname).toBe('/root/api');
    expect(state.remember).toHaveBeenCalledWith('source-a', 'https://copy.test/root');
  });
  it('remembers an empty valid custom search instead of continuing to other mirrors', async () => {
    state.route.mirrors = ['https://copy.test', 'https://another.test'];
    state.request.mockRejectedValueOnce(new ProviderNetworkError('dns')).mockResolvedValueOnce({ text: () => '{"results":[]}' });
    expect(await search(new SearchService())).toEqual([]); expect(state.request).toHaveBeenCalledTimes(2);
    expect(state.remember).toHaveBeenCalledWith('source-a', 'https://copy.test');
  });
  it.each(['custom', 'jackett', 'torznab'])('rejects malformed/login output from %s without selecting it or trying more aliases', async type => {
    state.providers[0] = { ...state.providers[0], type, url: 'https://site.test' };
    state.route.mirrors = ['https://copy.test'];
    state.request.mockResolvedValue({ text: () => '<html>login with secret token</html>' });
    expect(await search(new SearchService())).toEqual([]);
    expect(state.request).toHaveBeenCalledOnce(); expect(state.remember).not.toHaveBeenCalled();
  });
  it('keeps hashless download fingerprints stable across mirrored search URLs', async () => {
    state.route.mirrors = ['https://copy.test/prefix'];
    const service = new SearchService(); state.request.mockResolvedValue(searchResponse());
    const [primary] = await search(service); service.clearResultCache();
    state.route.lastWorkingMirror = 'https://copy.test/prefix';
    const [mirror] = await search(service);
    expect(mirror.historyKeys).toEqual(primary.historyKeys);
    expect(state.request.mock.calls[1][2]).toBe('https://copy.test/prefix/search?q=example');
  });
  it('resolves relative download URLs against the actual response path', async () => {
    state.route.mirrors = ['https://copy.test/prefix']; state.route.lastWorkingMirror = 'https://copy.test/prefix';
    state.request.mockResolvedValueOnce({ url: 'https://copy.test/prefix/api/search', text: () => JSON.stringify({ results: [{ title: 'Example', torrentUrl: 'download?id=1' }] }) }).mockResolvedValueOnce({ body: torrent });
    const service = new SearchService(); const [result] = await search(service); await service.resolveSource(result.sourceRefs);
    expect(state.request.mock.calls[1][2]).toBe('https://copy.test/prefix/api/download?id=1');
  });
  it('keeps third-party torrent URLs on their own trusted origin without mirror rebasing', async () => {
    state.route.mirrors = ['https://copy.test']; state.route.origins = ['https://copy.test', 'https://cdn.test'];
    state.request.mockResolvedValueOnce({ text: () => JSON.stringify({ results: [{ title: 'Example', torrentUrl: 'https://cdn.test/file.torrent' }] }) }).mockRejectedValueOnce(new ProviderNetworkError('dns'));
    const service = new SearchService(); const [result] = await search(service);
    await expect(service.resolveSource(result.sourceRefs)).rejects.toMatchObject({ code: 'dns' });
    expect(state.request).toHaveBeenCalledTimes(2); expect(state.request.mock.calls[1][2]).toBe('https://cdn.test/file.torrent');
  });
  it('rejects a valid torrent with a different known hash before staging or remembering an alias', async () => {
    state.route.mirrors = ['https://copy.test'];
    state.request.mockResolvedValueOnce({ text: () => JSON.stringify({ results: [{ title: 'Example', torrentUrl: '/private.torrent', infoHash: 'f'.repeat(40) }] }) }).mockResolvedValueOnce({ body: torrent });
    const service = new SearchService(); const [result] = await search(service); state.remember.mockClear();
    await expect(service.resolveSource(result.sourceRefs)).rejects.toThrow('metadata');
    expect(fs.existsSync(path.join(state.temp, 'havvn-search-torrents'))).toBe(false); expect(state.remember).not.toHaveBeenCalled();
  });
});
