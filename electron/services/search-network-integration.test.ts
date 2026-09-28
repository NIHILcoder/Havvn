import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ request: vi.fn(), providers: [] as any[], route: null as any, temp: '' }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => state.temp } }));
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }, httpFetch: vi.fn(), httpFetchText: vi.fn() }));
vi.mock('../db/store', () => ({ getSearchProviders: async () => state.providers }));
vi.mock('./provider-network', () => ({ providerNetwork: { request: state.request } }));
vi.mock('./provider-network-store', () => ({ getProviderRoute: () => state.route, rememberProviderMirror: vi.fn() }));
import { SearchService } from './search-service';
import { mergeResults } from '../../shared/search-dedupe';
const torrent = Buffer.from('d4:infod6:lengthi0e4:name4:test12:piece lengthi16384e6:pieces0:ee');
beforeEach(() => {
  vi.clearAllMocks();
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
  it('retrieves torrent metadata on the search source route and stages a valid local file', async () => {
    state.request.mockResolvedValueOnce(searchResponse()).mockResolvedValueOnce({ body: torrent });
    const service = new SearchService();
    const [result] = await search(service);
    expect(result.torrentUrl).toBeUndefined();
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
    const base = { title: 'Same', size: 123, seeds: 1, leechers: 0, infoHash: 'hash', provider: 'one', sourceRefs: ['one'] };
    const first = mergeResults([], [base]);
    const merged = mergeResults(first, [{ ...base, provider: 'two', sourceRefs: ['two'] }]);
    expect(merged[0].sourceRefs).toEqual(['one', 'two']);
    expect(first[0].sourceRefs).toEqual(['one']);
  });
});
