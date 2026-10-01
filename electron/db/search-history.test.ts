import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ stores: new Map<string, Record<string, unknown>>() }));
vi.mock('electron', () => ({ app: { getPath: () => 'D:/isolated-test' } }));
vi.mock('./secrets', () => ({ encryptSecret: (value: string) => value, decryptSecret: (value: string) => value }));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('electron-store', () => ({ default: class {
  private name: string;
  constructor(options: { name?: string; defaults: Record<string, unknown> }) {
    this.name = options.name ?? 'config';
    if (!state.stores.has(this.name)) state.stores.set(this.name, structuredClone(options.defaults));
  }
  get(key: string) { return structuredClone(state.stores.get(this.name)?.[key]); }
  set(key: string, value: unknown) { state.stores.get(this.name)![key] = structuredClone(value); }
  has(key: string) { return key in state.stores.get(this.name)!; }
  delete(key: string) { delete state.stores.get(this.name)![key]; }
} }));
import * as db from './store';
import { searchDownloadHistory } from '../services/search-download-history';
const key = 'b'.repeat(64);
beforeEach(() => {
  state.stores.get('downloads')!.downloads = {};
  searchDownloadHistory.clear();
});
async function fixture() {
  const download = await db.createDownload({ name: 'Film (2024) 1080p', sourceType: 'magnet',
    sourceUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), savePath: 'D:/isolated-test', status: 'paused' });
  searchDownloadHistory.remember(download, [key]);
  await db.updateDownloadField(download.id, 'infoHash', 'a'.repeat(40));
  return download;
}
describe('download lifecycle integration with search history', () => {
  it('archives a Classic explicit removal before deleting its record', async () => {
    const download = await fixture();
    await db.deleteDownload(download.id, true);
    expect(await db.getDownloadById(download.id)).toBeNull();
    expect(searchDownloadHistory.get()[0]).toMatchObject({ infoHash: 'a'.repeat(40), sourceKeys: [key], removedAt: expect.any(Number) });
  });
  it('archives a Native removal and keeps it through boot tombstone cleanup', async () => {
    const download = await fixture();
    await db.updateDownloadStatus(download.id, 'removed');
    const archived = searchDownloadHistory.get();
    await db.deleteDownload(download.id);
    expect(searchDownloadHistory.get()).toEqual(archived);
  });
  it('never revives cleared history during Native boot cleanup', async () => {
    const download = await fixture();
    await db.updateDownloadStatus(download.id, 'removed');
    searchDownloadHistory.clear();
    await db.deleteDownload(download.id);
    expect(searchDownloadHistory.get()).toEqual([]);
  });
  it('does not archive a rollback or a normal status update', async () => {
    const download = await fixture();
    await db.updateDownloadStatus(download.id, 'error', 'failed add');
    await db.deleteDownload(download.id);
    expect(searchDownloadHistory.get().every(entry => entry.removedAt === undefined)).toBe(true);
  });
  it('records non-search removals too, without inventing source associations', async () => {
    const download = await db.createDownload({ name: 'Other', sourceType: 'magnet',
      sourceUri: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), savePath: 'D:/isolated-test', status: 'paused' });
    await db.deleteDownload(download.id, true);
    expect(searchDownloadHistory.get()[0]).toMatchObject({ infoHash: 'c'.repeat(40), sourceKeys: [], removedAt: expect.any(Number) });
  });
});
