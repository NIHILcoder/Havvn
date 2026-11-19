import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../shared/types';

interface FakeMessage { kind: string; id?: number; method?: string; args?: unknown[]; result?: unknown; blocks?: string[] }
interface FakeChild extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn<(message: FakeMessage) => void>>;
  kill: () => void;
  bootSettings: AppSettings;
  init: FakeMessage;
}
const f = vi.hoisted(() => ({ children: [] as FakeChild[], base: {} as AppSettings, engine: 'native' as 'native' | 'webtorrent' }));
vi.mock('electron', () => ({ utilityProcess: { fork: () => {
  const child = new EventEmitter() as FakeChild;
  child.postMessage = vi.fn((message: FakeMessage) => {
    if (message.kind === 'init') { child.init = message; queueMicrotask(() => child.emit('message', { kind: 'db', id: -1, fn: 'getSettings', args: [] })); }
    else if (message.kind === 'db-res') { child.bootSettings = message.result as AppSettings; queueMicrotask(() => child.emit('message', { kind: 'ready' })); }
    else if (message.kind === 'rpc') queueMicrotask(() => child.emit('message', { kind: 'rpc-res', id: message.id, ok: true }));
  });
  child.kill = () => queueMicrotask(() => child.emit('exit', 0));
  f.children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
} } }));
vi.mock('../../db/store', () => ({ getSettings: async () => ({ ...f.base }), getCategories: async () => [], getScheduler: async () => ({ enabled: false, schedules: [] }) }));
vi.mock('../../services/automation-runtime', () => ({ getAutomationRules: () => ({ prepare: async (request: Record<string, unknown>) => ({ request: { ...request, paused: true }, receipt: undefined }) }) }));
vi.mock('../../services/download-defaults', () => ({ prepareDownloadDefaults: async (request: Record<string, unknown>) => ({ ...request, savePath: 'D:/resolved' }) }));
vi.mock('../../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } }));
vi.mock('../../services/ip-blocklist', () => ({ getIPBlocklistService: () => ({ getRanges: () => [] }) }));
vi.mock('./env', () => ({ getHostEnv: () => ({ engine: f.engine }) }));

beforeEach(() => {
  vi.resetModules(); f.children = []; f.base = { maxDownKbps: 1000, maxUpKbps: 0, altDownKbps: 0, altUpKbps: 0,
    altSpeedEnabled: false, maxConnectionsGlobal: 200, adaptiveUpload: false, dohEnabled: false, networkProfilesEnabled: true } as AppSettings;
  f.engine = 'native';
});
it('reports boot capabilities without spawning a host or applying a pending settings choice', async () => {
  const { getTorrentManager } = await import('./manager-proxy'); const proxy = getTorrentManager();
  f.base.engine = 'webtorrent';
  expect((await proxy.getEngineCapabilities()).engine).toBe('native');
  expect(f.children).toHaveLength(0); expect(f.base.engine).toBe('webtorrent');
});
it('routes every new download through automation before defaults and strips incoming receipts', async () => {
  const { getTorrentManager } = await import('./manager-proxy'); const proxy = getTorrentManager();
  await proxy.addDownload({sourceType:'magnet',sourceUri:'magnet:test',paused:false,automation:{added:{} as never}});
  const message=f.children[0].postMessage.mock.calls.map(([m])=>m).find(m=>m.kind==='rpc'&&m.method==='addDownload');
  expect(message?.args?.[0]).toMatchObject({paused:true,savePath:'D:/resolved'});expect((message?.args?.[0] as Record<string,unknown>).automation).toBeUndefined();await proxy.destroy();
});
it('reports Classic when the boot environment fell back from a configured Native engine', async () => {
  f.engine = 'webtorrent'; f.base.engine = 'native';
  const { getTorrentManager } = await import('./manager-proxy'); const proxy = getTorrentManager();
  expect((await proxy.getEngineCapabilities()).features.boundedEpisodePrefetch.supported).toBe(true);
  expect(f.children).toHaveLength(0);
});
it('preserves creation/cancel request ordering while waiting for the host to boot', async () => {
  const { getTorrentManager } = await import('./manager-proxy'); const proxy = getTorrentManager();
  const request = { requestId: 'create-and-cancel', sourcePaths: ['D:/file'], outputPath: 'D:/out.torrent', options: { announceList: [] } };
  await Promise.all([proxy.createTorrentFile(request), proxy.cancelTorrentCreation(request.requestId)]);
  const messages = f.children[0].postMessage.mock.calls.map(([m]) => m).filter(m => ['createTorrentFile', 'cancelTorrentCreation'].includes(m.method || ''));
  expect(messages.map(m => m.method)).toEqual(['createTorrentFile', 'cancelTorrentCreation']);
  expect(messages.map(m => m.args)).toEqual([[request], [request.requestId]]);
  await proxy.destroy();
});
it('sends derived settings on startup and replays current policies on host restart without changing the store', async () => {
  const { getTorrentManager } = await import('./manager-proxy'); const proxy = getTorrentManager();
  await proxy.setNetworkProfile({ id: 'phone', name: 'Phone', networkKey: 'x', overrides: { maxDownKbps: 120 } });
  const first = f.children[0]; expect(first.bootSettings.maxDownKbps).toBe(120); expect(f.base.maxDownKbps).toBe(1000);
  proxy.setTransferBlock('disk', true); f.base.maxDownKbps = 50;
  await proxy.restartEngine();
  expect(f.children[1].init.blocks).toEqual(['disk']); expect(f.children[1].bootSettings.maxDownKbps).toBe(50);
  await expect(proxy.resumeAllPaused()).rejects.toMatchObject({ code: 'TRANSFER_BLOCKED' });
  expect(f.children[1].postMessage.mock.calls.some(([m]) => m.method === 'resumeAllPaused')).toBe(false);
  proxy.setTransferBlock('disk', false); await proxy.destroy();
});
it('routes unrelated settings updates through the policy writer', async () => {
  const { getTorrentManager } = await import('./manager-proxy'); const proxy = getTorrentManager();
  await proxy.setNetworkProfile({ id: 'phone', name: 'Phone', networkKey: 'x', overrides: { maxDownKbps: 120 } });
  await proxy.updateSettings({ maxDownKbps: 1000, maxConnections: 40 });
  const writes = f.children[0].postMessage.mock.calls.map(([m]) => m).filter(m => m.method === 'updateSettings');
  expect(writes.at(-1)?.args?.[0]).toMatchObject({ maxDownKbps: 120, maxConnections: 40 });
  await proxy.destroy();
});
