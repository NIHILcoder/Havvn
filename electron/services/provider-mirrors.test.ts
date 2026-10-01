import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderNetworkError, type ProviderNetworkCode } from '../../shared/provider-network';
import type { SearchProvider } from '../../shared/types';
import type { ProviderConnection } from '../../shared/provider-network';
const state = vi.hoisted(() => ({ request: vi.fn(), acquire: vi.fn(), remember: vi.fn(), route: {} as { connection: ProviderConnection; origins: string[]; mirrors: string[]; lastWorkingMirror?: string } }));
vi.mock('./provider-network', () => ({ providerNetwork: { request: state.request, acquireSession: state.acquire } }));
vi.mock('./provider-network-store', () => ({ getProviderRoute: () => state.route, rememberProviderMirror: state.remember }));
import { readHttpMirrors } from './provider-mirrors';
const provider = { id: 'test', name: 'Source', type: 'custom', url: 'https://main.test/search' } as SearchProvider;
let lease: AbortController;
let release: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks(); lease = new AbortController(); release = vi.fn();
  state.acquire.mockResolvedValue({ signal: lease.signal, release });
  state.route = { connection: { mode: 'proxy', protocol: 'socks5', host: 'localhost', port: 1080 }, origins: ['https://copy.test', 'https://sign-in.test'], mirrors: ['https://copy.test'] };
});
afterEach(() => vi.useRealTimers());
const read = () => readHttpMirrors(provider, 'https://main.test/search?q=x&apikey=secret', r => r.text());

describe('bounded mirror reads', () => {
  it.each(['dns', 'network', 'timeout', 'server'] as ProviderNetworkCode[])('tries the next alias after %s on the same mandatory proxy', async code => {
    state.request.mockRejectedValueOnce(new ProviderNetworkError(code)).mockResolvedValueOnce({ text: () => '[]' });
    expect(await read()).toBe('[]');
    expect(state.request.mock.calls.map(c => c[2])).toEqual(['https://main.test/search?q=x&apikey=secret', 'https://copy.test/search?q=x&apikey=secret']);
    expect(state.request.mock.calls.every(c => c[1] === state.route.connection && c[3].timeoutMs === 5000)).toBe(true);
    expect(state.remember).toHaveBeenCalledWith('test', 'https://copy.test');
    expect(release).toHaveBeenCalledOnce();
  });
  it.each(['auth', 'captcha', 'forbidden', 'rate-limit', 'proxy', 'tls', 'redirect', 'invalid-response', 'too-large', 'invalid-url', 'http', 'cancelled'] as ProviderNetworkCode[])('stops on %s without replaying the query on other domains', async code => {
    state.request.mockRejectedValue(new ProviderNetworkError(code));
    await expect(read()).rejects.toMatchObject({ code });
    expect(state.request).toHaveBeenCalledOnce(); expect(state.remember).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });
  it('does not remember an HTTP 200 login/error response rejected by the parser', async () => {
    state.request.mockResolvedValue({ text: () => '<html>login</html>' });
    await expect(readHttpMirrors(provider, provider.url, () => { throw new ProviderNetworkError('invalid-response'); })).rejects.toMatchObject({ code: 'invalid-response' });
    expect(state.request).toHaveBeenCalledOnce(); expect(state.remember).not.toHaveBeenCalled();
  });
  it('cancels between attempts when the session is reset', async () => {
    state.request.mockImplementationOnce(async () => { lease.abort(); throw new ProviderNetworkError('network'); });
    await expect(read()).rejects.toMatchObject({ code: 'cancelled' });
    expect(state.request).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  });
  it('does not start any request after explicit cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readHttpMirrors(provider, provider.url, () => true, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(state.acquire).not.toHaveBeenCalled(); expect(state.request).not.toHaveBeenCalled();
  });
  it('enforces a common 20-second budget and a maximum of four addresses', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    state.route.mirrors = Array.from({ length: 10 }, (_, i) => `https://copy${i}.test`);
    state.request.mockImplementation(async (_id, _connection, _url, options) => {
      vi.setSystemTime(Date.now() + options.timeoutMs); throw new ProviderNetworkError('timeout');
    });
    await expect(read()).rejects.toMatchObject({ code: 'timeout' });
    expect(state.request).toHaveBeenCalledTimes(4); expect(Date.now()).toBe(20000);
  });
  it('caps fast failures as well as timeouts', async () => {
    state.route.mirrors = Array.from({ length: 10 }, (_, i) => `https://copy${i}.test`);
    state.request.mockRejectedValue(new ProviderNetworkError('dns'));
    await expect(read()).rejects.toMatchObject({ code: 'dns' }); expect(state.request).toHaveBeenCalledTimes(4);
  });
  it('uses the remaining download budget, without giving each alias a new deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    state.request.mockImplementationOnce(async () => { vi.setSystemTime(1100); throw new ProviderNetworkError('network'); }).mockResolvedValueOnce({ text: () => 'ok' });
    await readHttpMirrors(provider, provider.url, r => r.text(), { timeoutMs: 1500 });
    expect(state.request.mock.calls.map(c => c[3].timeoutMs)).toEqual([1500, 400]);
  });
  it('retains a full request timeout when there are no aliases', async () => {
    state.route.mirrors = []; state.request.mockResolvedValue({ text: () => 'ok' });
    await read(); expect(state.request.mock.calls[0][3].timeoutMs).toBe(20000);
  });
  it('forgets a stale preference when the implicit primary is healthy again', async () => {
    state.route.lastWorkingMirror = 'https://copy.test';
    state.request.mockRejectedValueOnce(new ProviderNetworkError('network')).mockResolvedValueOnce({ text: () => 'ok' });
    await read(); expect(state.request.mock.calls[0][2]).toContain('copy.test'); expect(state.remember).toHaveBeenCalledWith('test', null);
  });
  it('returns valid output if persisting the address hint fails', async () => {
    state.request.mockResolvedValue({ text: () => 'ok' }); state.remember.mockImplementation(() => { throw new Error('Disk unavailable'); });
    expect(await read()).toBe('ok'); expect(release).toHaveBeenCalledOnce();
  });
});
