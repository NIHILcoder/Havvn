import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransmissionRpc, TransmissionRpcError } from './transmission-rpc';

/** Build a fetch Response-alike. */
function res(status: number, body?: unknown, headers?: Record<string, string>) {
  const h = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

const ok = (args: unknown = {}) => res(200, { result: 'success', arguments: args });

describe('TransmissionRpc session-id handshake', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('retries once on 409, adopting the session id for the replay AND later calls', async () => {
    fetchMock
      .mockResolvedValueOnce(res(409, undefined, { 'X-Transmission-Session-Id': 'sid-1' }))
      .mockResolvedValueOnce(ok({ version: '4.x' }))
      .mockResolvedValueOnce(ok({}));
    const rpc = new TransmissionRpc({ port: 9091 });

    const out = await rpc.sessionGet();
    expect(out).toEqual({ version: '4.x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The replay carries the id…
    expect(fetchMock.mock.calls[1][1].headers['x-transmission-session-id']).toBe('sid-1');
    // …and so does the NEXT call (no fresh 409 round-trip).
    await rpc.call('torrent-stop', { ids: 1 });
    expect(fetchMock.mock.calls[2][1].headers['x-transmission-session-id']).toBe('sid-1');
  });

  it('throws when 409 comes without a session id header', async () => {
    fetchMock.mockResolvedValue(res(409));
    const rpc = new TransmissionRpc({ port: 9091 });
    await expect(rpc.sessionGet()).rejects.toThrow(TransmissionRpcError);
  });

  it('surfaces a daemon-level failure (result !== success) as TransmissionRpcError', async () => {
    fetchMock.mockResolvedValue(ok());
    fetchMock.mockResolvedValueOnce(res(200, { result: 'invalid or corrupt torrent file', arguments: {} }));
    const rpc = new TransmissionRpc({ port: 9091 });
    await expect(rpc.call('torrent-add', { filename: 'x' })).rejects.toThrow(/invalid or corrupt/);
  });

  it('sends Basic auth when credentials are configured and maps 401', async () => {
    fetchMock.mockResolvedValue(res(401));
    const rpc = new TransmissionRpc({ port: 9091, username: 'u', password: 'p' });
    await expect(rpc.sessionGet()).rejects.toThrow(/unauthorized/);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['authorization']).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });
});

describe('TransmissionRpc torrent helpers', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('torrentAdd normalizes torrent-added vs torrent-duplicate', async () => {
    const t = { id: 3, hashString: 'ab'.repeat(20), name: 'x' };
    fetchMock.mockResolvedValueOnce(ok({ 'torrent-added': t }));
    const rpc = new TransmissionRpc({ port: 9091 });
    expect(await rpc.torrentAdd({ filename: 'magnet:?xt=urn:btih:...' })).toEqual({ ...t, duplicate: false });

    fetchMock.mockResolvedValueOnce(ok({ 'torrent-duplicate': t }));
    expect(await rpc.torrentAdd({ filename: 'magnet:?xt=urn:btih:...' })).toEqual({ ...t, duplicate: true });
  });

  it('torrentAdd base64-encodes metainfo', async () => {
    fetchMock.mockResolvedValueOnce(ok({ 'torrent-added': { id: 1, hashString: 'h', name: 'n' } }));
    const rpc = new TransmissionRpc({ port: 9091 });
    await rpc.torrentAdd({ metainfo: Buffer.from('d8:announce0:e'), paused: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.arguments.metainfo).toBe(Buffer.from('d8:announce0:e').toString('base64'));
    expect(body.arguments.paused).toBe(true);
  });

  it('torrentSet keeps ids alongside mutators; torrentRemove maps delete-local-data', async () => {
    fetchMock.mockResolvedValue(ok());
    const rpc = new TransmissionRpc({ port: 9091 });
    await rpc.torrentSet('a1b2', { 'files-unwanted': [0, 2] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).arguments).toEqual({ 'files-unwanted': [0, 2], ids: 'a1b2' });
    await rpc.torrentRemove([1, 2], true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).arguments).toEqual({ ids: [1, 2], 'delete-local-data': true });
  });
});
