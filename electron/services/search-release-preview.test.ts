import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), route: { connection: { mode: 'proxy', protocol: 'socks5', host: 'proxy.example', port: 1080 } } }));
vi.mock('./rutracker-source', () => ({ readRuTrackerDetails: mock.read }));
vi.mock('./provider-network', () => ({ providerNetwork: { request: mock.request } }));
vi.mock('./provider-network-store', () => ({ getProviderRoute: () => mock.route }));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toJPEG: () => Buffer.from('normalized') }) } }));
import { SearchReleasePreview } from './search-release-preview';
import { ProviderNetworkError } from '../../shared/provider-network';

const source = { ref: 'opaque-source', provider: { id: 'rt', name: 'RuTracker', type: 'rutracker' as const, url: 'https://tracker.example/forum', enabled: true },
  result: { title: 'Search title', size: 42, seeds: 4, leechers: 1, provider: 'RuTracker', detailsUrl: 'https://tracker.example/forum/viewtopic.php?t=7' } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXkAAAAASUVORK5CYII=', 'base64');
function page(images = [{ url: 'https://images.example/cover.png', poster: true, label: 'Cover' }]) {
  return { url: source.result.detailsUrl, details: { available: true, title: 'Full release title', blocks: [{ kind: 'paragraph', text: 'Synopsis' }], images, truncated: false } };
}
beforeEach(() => { vi.clearAllMocks(); mock.read.mockResolvedValue(page()); mock.request.mockResolvedValue({ body: png }); });

it('reads details lazily, caches by topic and refreshes explicitly', async () => {
  const service = new SearchReleasePreview(); expect(mock.read).not.toHaveBeenCalled();
  const first = await service.details([source], 'one'); expect(first.title).toBe('Full release title');
  expect(first.poster?.id).toBeTruthy(); expect(JSON.stringify(first)).not.toContain('images.example');
  expect(await service.details([{ ...source, ref: 'new-ref' }], 'two')).toMatchObject({ source: { ref: 'new-ref' }, poster: first.poster });
  expect(mock.read).toHaveBeenCalledOnce();
  const fresh = await service.details([source], 'three', undefined, true); expect(fresh.poster?.id).not.toBe(first.poster?.id);
  await expect(service.image(first.poster!.id, 'four')).rejects.toThrow('expired');
});
it('reuses image capabilities when two windows finish reading the same topic', async () => {
  let finishFirst!: (value: unknown) => void, finishSecond!: (value: unknown) => void;
  mock.read.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
  const service = new SearchReleasePreview();
  const firstPending = service.details([source], 'one');
  const secondPending = service.details([{ ...source, ref: 'second-window' }], 'two');
  finishFirst(page()); const first = await firstPending;
  finishSecond(page()); const second = await secondPending;
  expect(second.poster).toEqual(first.poster);
  expect(second.source.ref).toBe('second-window');
  await service.image(first.poster!.id, 'three');
  await service.image(second.poster!.id, 'four'); expect(mock.request).toHaveBeenCalledOnce();
  await service.details([source], 'five', undefined, true);
  await expect(service.image(first.poster!.id, 'six')).rejects.toThrow('expired');
});
it('does not fetch arbitrary or unsupported source pages and honors explicit source selection', async () => {
  const service = new SearchReleasePreview(), other = { ...source, ref: 'other', provider: { ...source.provider, id: 'custom', type: 'custom' as const } };
  expect(await service.details([other], 'one')).toMatchObject({ supported: false, blocks: [] }); expect(mock.read).not.toHaveBeenCalled();
  expect(await service.details([other, source], 'two')).toMatchObject({ source: { ref: source.ref } });
  expect(await service.details([other, source], 'three', 'other')).toMatchObject({ supported: false });
  await expect(service.details([source], 'four', 'forged')).rejects.toThrow();
});
it('only serves registered images through the configured route without external cookies', async () => {
  const service = new SearchReleasePreview(), details = await service.details([source], 'one');
  await expect(service.image('https://arbitrary.example/image.jpg', 'two')).rejects.toThrow('expired');
  expect(mock.request).not.toHaveBeenCalled();
  expect(await service.image(details.poster!.id, 'three')).toMatch(/^data:image\/jpeg;base64,/);
  expect(mock.request).toHaveBeenCalledWith('rt', mock.route.connection, 'https://images.example/cover.png', expect.objectContaining({ omitCookies: true, maxBytes: 3 * 1024 * 1024, allowedOrigins: ['https://images.example'] }));
  await service.image(details.poster!.id, 'four'); expect(mock.request).toHaveBeenCalledOnce();
});
it('retains the source session only for a same-origin image and drops private URLs', async () => {
  mock.read.mockResolvedValue(page([{ url: 'https://tracker.example/cover.jpg', poster: true, label: '' }, { url: 'http://127.0.0.1/private', poster: false, label: '' }]));
  const service = new SearchReleasePreview(), details = await service.details([source], 'one');
  expect(details.screenshots).toHaveLength(0); await service.image(details.poster!.id, 'two');
  expect(mock.request.mock.calls[0][3].omitCookies).toBe(false);
});
it('returns actionable failures without caching them and permits retry', async () => {
  mock.read.mockRejectedValueOnce(new ProviderNetworkError('captcha'));
  const service = new SearchReleasePreview();
  expect(await service.details([source], 'one')).toMatchObject({ failure: 'captcha', source: { ref: 'opaque-source' } });
  expect(await service.details([source], 'two')).toMatchObject({ title: 'Full release title' }); expect(mock.read).toHaveBeenCalledTimes(2);
});
it('cancels active detail reads and never caches the late result', async () => {
  let finish!: (value: unknown) => void;
  mock.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const service = new SearchReleasePreview(), pending = service.details([source], 'one');
  service.cancel('one'); finish(page()); await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await service.details([source], 'two'); expect(mock.read).toHaveBeenCalledTimes(2);
});
it('clears image capabilities on logout or route changes', async () => {
  const service = new SearchReleasePreview(), details = await service.details([source], 'one');
  service.clear(); await expect(service.image(details.poster!.id, 'two')).rejects.toThrow('expired');
  expect(mock.request).not.toHaveBeenCalled();
});
it('rejects oversized or non-bitmap responses instead of handing HTML to the renderer', async () => {
  const service = new SearchReleasePreview(), details = await service.details([source], 'one');
  mock.request.mockResolvedValueOnce({ body: Buffer.from('<html>Log in</html>') });
  await expect(service.image(details.poster!.id, 'two')).rejects.toThrow('Unsupported');
  mock.request.mockResolvedValueOnce({ body: Buffer.alloc(3 * 1024 * 1024 + 1) });
  await expect(service.image(details.poster!.id, 'three')).rejects.toMatchObject({ code: 'too-large' });
});
it('bounds simultaneous image reads and cancels the waiting queue', async () => {
  mock.read.mockResolvedValue(page([0,1,2,3].map(i => ({ url: `https://images.example/${i}.jpg`, poster: i === 0, label: '' }))));
  mock.request.mockImplementation((_id, _connection, _url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new ProviderNetworkError('cancelled')), { once: true });
  }));
  const service = new SearchReleasePreview(), details = await service.details([source], 'one');
  const jobs = [details.poster!, ...details.screenshots].map((image, i) => service.image(image.id, 'image-' + i));
  const all = Promise.allSettled(jobs); await vi.waitFor(() => expect(mock.request).toHaveBeenCalledTimes(2));
  service.clear(); expect((await all).every(result => result.status === 'rejected')).toBe(true);
});
