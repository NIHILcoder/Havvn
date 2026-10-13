import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Download, DownloadStats } from '../../shared/types';
import { createDownloadState } from './download-state';

function download(id: string, patch: Partial<Download> = {}): Download {
  return { id, name: id, sourceType: 'magnet', sourceUri: '', torrentFilePath: null, savePath: '',
    status: 'downloading', progress: .1, downloadedBytes: 10, uploadedBytes: 1, downSpeedBps: 0,
    upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0, totalSize: 100, priority: 1, category: null,
    createdAt: new Date(0), updatedAt: new Date(0), lastError: null, ...patch };
}
function stats(id: string, patch: Partial<DownloadStats> = {}): DownloadStats {
  return { id, progress: .2, downloadedBytes: 20, uploadedBytes: 2, downSpeedBps: 10,
    upSpeedBps: 1, etaSeconds: 8, peers: 3, seeds: 1, status: 'downloading', ...patch };
}
function fixture(list = [download('a'), download('b')]) {
  const getDownloads = vi.fn(async () => structuredClone(list));
  const off = vi.fn(), onDownloadStats = vi.fn(() => off);
  return { model: createDownloadState(() => ({ getDownloads, onDownloadStats })), getDownloads, onDownloadStats, off };
}
afterEach(() => vi.useRealTimers());

describe('shared downloads state', () => {
  it('keeps equal records and stats stable and only changes the affected row', async () => {
    const { model } = fixture(); await model.refresh(); model.receiveStats([stats('a'), stats('b')]);
    const before = model.store.getState();
    model.receiveStats([stats('a', { progress: .3 }), stats('b')]);
    const after = model.store.getState();
    expect(after.downloads).toBe(before.downloads);
    expect(after.byId).toBe(before.byId);
    expect(after.statsById.get('b')).toBe(before.statsById.get('b'));
    expect(after.statsById.get('a')?.progress).toBe(.3);
    expect(after.counts).toBe(before.counts); expect(after.totals).toBe(before.totals);
    await model.refresh(); expect(model.store.getState().downloads).toBe(before.downloads);
  });

  it('calculates counts and bytes with live stats and persisted fallbacks', async () => {
    const { model } = fixture([download('a'), download('b', { status: 'queued' }),
      download('c', { status: 'seeding' }), download('d', { status: 'removed' })]);
    await model.refresh(); model.receiveStats([stats('a', { status: 'paused' }), stats('c', { status: 'seeding' })]);
    expect(model.store.getState().counts).toEqual({ all: 3, downloading: 1, completed: 1, seeding: 1, paused: 1, error: 0 });
    expect(model.store.getState().totals).toEqual({ active: 0, downSpeed: 20, upSpeed: 2, peers: 6, downloaded: 50, uploaded: 5 });
    model.receiveStats([]); expect(model.store.getState().statsById.size).toBe(0);
    expect(model.store.getState().totals.downloaded).toBe(30);
  });

  it('uses exactly one listener and timer across app/page owners, including remount', async () => {
    vi.useFakeTimers(); const f = fixture();
    const releaseApp = f.model.retain(), releasePage = f.model.retain();
    await f.model.refresh();
    expect(f.onDownloadStats).toHaveBeenCalledTimes(1); expect(f.getDownloads).toHaveBeenCalledTimes(1);
    releasePage(); releasePage(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.getDownloads).toHaveBeenCalledTimes(2); expect(f.off).not.toHaveBeenCalled();
    releaseApp(); expect(f.off).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000); expect(f.getDownloads).toHaveBeenCalledTimes(2);
    const release = f.model.retain(); await f.model.refresh();
    expect(f.onDownloadStats).toHaveBeenCalledTimes(2); release();
  });

  it('coalesces pulls and lets a newer stats push win a slow DB response', async () => {
    const f = fixture(); await f.model.refresh();
    let resolve!: (value: Download[]) => void;
    f.getDownloads.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pull = f.model.refresh(); expect(f.model.refresh()).toBe(pull);
    f.model.receiveStats([stats('a', { status: 'seeding', progress: 1 })]);
    resolve([download('a')]); await pull;
    expect(f.model.store.getState().byId.get('a')?.status).toBe('seeding');
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(1);
    f.getDownloads.mockResolvedValueOnce([download('a', { status: 'paused' })]); await f.model.refresh();
    expect(f.model.store.getState().statsById.get('a')?.status).toBe('paused');
  });

  it('does not resurrect a local deletion from an older pull and releases its stats', async () => {
    const f = fixture(); await f.model.refresh(); f.model.receiveStats([stats('a'), stats('b')]);
    let resolve!: (value: Download[]) => void;
    f.getDownloads.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.getDownloads.mockResolvedValueOnce([download('b')]);
    const pull = f.model.refresh();
    f.model.updateDownloads(list => list.filter(d => d.id !== 'a'));
    expect(f.model.store.getState().statsById.has('a')).toBe(false);
    resolve([download('a'), download('b')]); await pull;
    expect(f.model.store.getState().downloads.map(d => d.id)).toEqual(['b']);
  });

  it('applies new metadata and ordering, supports retry after a failed pull', async () => {
    const f = fixture(); await f.model.refresh(); const before = f.model.store.getState();
    f.getDownloads.mockRejectedValueOnce(Error('unavailable')); await expect(f.model.refresh()).rejects.toThrow('unavailable');
    expect(f.model.store.getState()).toBe(before);
    f.getDownloads.mockResolvedValueOnce([download('b', { category: 'new', selectedFiles: [1] }), download('a')]);
    await f.model.refresh(); expect(f.model.store.getState().downloads.map(d => d.id)).toEqual(['b', 'a']);
    expect(f.model.store.getState().byId.get('a')).toBe(before.byId.get('a'));
    expect(f.model.store.getState().byId.get('b')?.selectedFiles).toEqual([1]);
  });

  it('updates completion predicates without updating metadata on every progress tick', async () => {
    const f = fixture(); await f.model.refresh();
    const old = f.model.store.getState().byId.get('a');
    f.model.receiveStats([stats('a', { progress: .99 })]); expect(f.model.store.getState().byId.get('a')).toBe(old);
    f.model.receiveStats([stats('a', { progress: 1 })]); expect(f.model.store.getState().byId.get('a')?.progress).toBe(1);
    f.model.receiveStats([stats('a', { progress: .01 })]); expect(f.model.store.getState().byId.get('a')?.progress).toBe(.01);
  });

  it('does not retain removed/unknown stats or repeatedly pull unknown ids', async () => {
    const f = fixture(); await f.model.refresh();
    f.model.receiveStats([stats('a', { status: 'removed' }), stats('unknown')]); await f.model.refresh();
    const calls = f.getDownloads.mock.calls.length;
    f.model.receiveStats([stats('unknown')]); f.model.receiveStats([stats('unknown')]);
    expect(f.getDownloads).toHaveBeenCalledTimes(calls);
    expect(f.model.store.getState().statsById.size).toBe(0);
  });
});
