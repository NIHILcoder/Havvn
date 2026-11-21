import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Download, DownloadStats } from '../../shared/types';
import { createDownloadState } from './download-state';
import { downloadOperation } from '../../shared/download-operation';

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

describe('download UI visibility', () => {
  it('does not turn an unresolved engine id into an urgent numeric publication on every hidden tick', async () => {
    const f = fixture([download('a')]); await f.model.refresh(); f.model.receiveStats([stats('a')]); f.model.setActivity(false);
    f.model.receiveStats([stats('a'), stats('pending')]); await f.model.refresh();
    const publish = vi.fn(); f.model.store.subscribe(publish); const reads = f.getDownloads.mock.calls.length;
    for (let i = 1; i < 10; i++) f.model.receiveStats([stats('a', { progress: .2 + i / 100 }), stats('pending')]);
    expect(publish).not.toHaveBeenCalled(); expect(f.getDownloads).toHaveBeenCalledTimes(reads);
    f.model.receiveStats([stats('a', { status: 'error' }), stats('pending')]);
    expect(f.model.store.getState().byId.get('a')?.status).toBe('error');
  });
  it('keeps a visible child live independently and rests only after its last demand is released', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); const release = f.model.retain(); await f.model.refresh();
    f.model.receiveStats([stats('a')]); f.model.setActivity(false);
    const childA = f.model.retainVisibleCounters(), childB = f.model.retainVisibleCounters();
    f.model.receiveStats([stats('a', { progress: .7 })]); expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.7);
    childA(); childA(); f.model.receiveStats([stats('a', { progress: .8 })]);
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.8); await f.model.refresh();
    const reads = f.getDownloads.mock.calls.length; await vi.advanceTimersByTimeAsync(5000);
    expect(f.getDownloads).toHaveBeenCalledTimes(reads + 1); expect(f.onDownloadStats).toHaveBeenCalledOnce();
    childB(); f.model.receiveStats([stats('a', { progress: .9 })]); await vi.advanceTimersByTimeAsync(6000);
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.8); expect(f.getDownloads).toHaveBeenCalledTimes(reads + 1);
    const childC = f.model.retainVisibleCounters(); expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.9);
    await f.model.refresh(); childC(); release(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains one critical subscription, pauses hidden metadata polling and coalesces numeric pushes', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); const release = f.model.retain(); await f.model.refresh();
    f.model.receiveStats([stats('a')]); f.model.setActivity(false);
    const publish = vi.fn(); f.model.store.subscribe(publish); const reads = f.getDownloads.mock.calls.length;
    for (let i = 1; i <= 60; i++) { f.model.receiveStats([stats('a', { progress: .2 + i / 100 })]); await vi.advanceTimersByTimeAsync(100); }
    expect(publish).not.toHaveBeenCalled(); expect(f.getDownloads).toHaveBeenCalledTimes(reads);
    expect(f.onDownloadStats).toHaveBeenCalledOnce(); expect(f.off).not.toHaveBeenCalled();
    f.model.setActivity(true); expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.8);
    await f.model.refresh(); expect(f.getDownloads).toHaveBeenCalledTimes(reads + 1);
    await vi.advanceTimersByTimeAsync(5000); expect(f.getDownloads).toHaveBeenCalledTimes(reads + 2);
    release(); expect(vi.getTimerCount()).toBe(0); expect(f.off).toHaveBeenCalledOnce();
  });
  it('does not flush a pending counter timer when hidden or when resource mode changes in the background', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); await f.model.refresh(); f.model.receiveStats([stats('a')]);
    f.model.setStatsInterval(1000); f.model.receiveStats([stats('a', { progress: .8 })]);
    f.model.setActivity(false); f.model.setStatsInterval(0); await vi.advanceTimersByTimeAsync(6000);
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.2); expect(vi.getTimerCount()).toBe(0);
    f.model.setActivity(true); expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.8);
  });
  it('keeps pause, failure, completion and actionable operation changes immediate in the background', async () => {
    const f = fixture([download('a')]); await f.model.refresh(); f.model.receiveStats([stats('a')]); f.model.setActivity(false);
    for (const status of ['paused', 'error', 'seeding'] as const) {
      f.model.receiveStats([stats('a', { status, progress: status === 'seeding' ? 1 : .3 })]);
      expect(f.model.store.getState().byId.get('a')?.status).toBe(status);
    }
    const operation = downloadOperation(download('a'), { stage: 'checking', fraction: .2 });
    f.model.receiveStats([stats('a', { operation })]);
    expect(f.model.store.getState().statsById.get('a')?.operation).toEqual(operation);
  });
  it('refreshes a removed item while hidden and does not resurrect a local removal from deferred counters', async () => {
    const f = fixture([download('a')]); const release = f.model.retain(); await f.model.refresh(); f.model.receiveStats([stats('a')]);
    f.model.setActivity(false); f.getDownloads.mockResolvedValue([]);
    f.model.receiveStats([stats('a', { status: 'removed' })]); await f.model.refresh();
    expect(f.model.store.getState().downloads).toEqual([]); release();
    const g = fixture([download('a')]); await g.model.refresh(); g.model.receiveStats([stats('a')]); g.model.setActivity(false);
    g.model.receiveStats([stats('a', { progress: .8 })]); g.model.updateDownloads(() => []); g.model.setActivity(true);
    expect(g.model.store.getState().downloads).toEqual([]); expect(g.model.store.getState().statsById.size).toBe(0);
  });
  it('invalidates a pre-resume pull and requests fresh metadata instead of accepting its old snapshot', async () => {
    const f = fixture([download('a')]); const release = f.model.retain(); await f.model.refresh(); f.model.receiveStats([stats('a')]);
    let finish!: (rows: Download[]) => void;
    f.getDownloads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.model.refresh(); f.model.setActivity(false); f.model.receiveStats([stats('a', { progress: .8 })]);
    f.getDownloads.mockResolvedValueOnce([download('a', { name: 'fresh' })]);
    f.model.setActivity(true); finish([download('a', { name: 'old' })]); await pending;
    expect(f.model.store.getState().byId.get('a')).toMatchObject({ name: 'fresh', progress: .8 }); release();
  });
  it('can suspend counters without hiding the window, and repeated activation never duplicates owners', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); const a = f.model.retain(), b = f.model.retain(); await f.model.refresh();
    f.model.receiveStats([stats('a')]); f.model.setActivity(true, false);
    f.model.receiveStats([stats('a', { progress: .6 })]); expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.2);
    await vi.advanceTimersByTimeAsync(5000); const reads = f.getDownloads.mock.calls.length; expect(reads).toBe(2);
    for (let i = 0; i < 10; i++) { f.model.setActivity(false); f.model.setActivity(true); }
    await f.model.refresh(); expect(f.onDownloadStats).toHaveBeenCalledOnce();
    a(); expect(f.off).not.toHaveBeenCalled(); b(); expect(f.off).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    const stoppedReads = f.getDownloads.mock.calls.length; f.model.setActivity(false); f.model.setActivity(true);
    await vi.advanceTimersByTimeAsync(10000); expect(f.getDownloads).toHaveBeenCalledTimes(stoppedReads);
  });
});

describe('shared downloads state', () => {
  it('does not add latency when source counters already arrive once a second or slower', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); await f.model.refresh(); f.model.setStatsInterval(1000);
    f.model.receiveStats([stats('a')]); await vi.advanceTimersByTimeAsync(1000);
    f.model.receiveStats([stats('a', { progress: .6 })]); expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.6);
    await vi.advanceTimersByTimeAsync(1500); f.model.receiveStats([stats('a', { progress: .7 })]);
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.7);
  });
  it('coalesces optional counters but immediately publishes pause, error and completion', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); await f.model.refresh(); f.model.receiveStats([stats('a')]);
    f.model.setStatsInterval(1000); const publish = vi.fn(); f.model.store.subscribe(publish);
    for (let i = 1; i <= 9; i++) f.model.receiveStats([stats('a', { progress: .2 + i / 100 })]);
    expect(publish).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledOnce(); expect(f.model.store.getState().statsById.get('a')?.progress).toBeCloseTo(.29);
    f.model.receiveStats([stats('a', { status: 'error' })]); expect(f.model.store.getState().byId.get('a')?.status).toBe('error');
    f.model.receiveStats([stats('a', { status: 'paused' })]); expect(f.model.store.getState().byId.get('a')?.status).toBe('paused');
    f.model.receiveStats([stats('a', { progress: 1, status: 'seeding' })]); expect(f.model.store.getState().byId.get('a')?.progress).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); expect(f.model.store.getState().byId.get('a')?.status).toBe('seeding');
  });
  it('flushes the latest counters on exit from economy and cannot resurrect a locally removed row', async () => {
    vi.useFakeTimers(); const f = fixture([download('a')]); await f.model.refresh(); f.model.receiveStats([stats('a')]);
    f.model.setStatsInterval(1000); f.model.receiveStats([stats('a', { progress: .7 })]); f.model.setStatsInterval(0);
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.7);
    f.model.setStatsInterval(1000); f.model.receiveStats([stats('a', { progress: .8 })]); f.model.updateDownloads(() => []);
    await vi.advanceTimersByTimeAsync(1000); expect(f.model.store.getState().downloads).toEqual([]); expect(f.model.store.getState().statsById.size).toBe(0);
  });
  it('a stale DB response cannot replace counters waiting for their UI publication', async () => {
    const f = fixture([download('a')]); await f.model.refresh(); f.model.receiveStats([stats('a')]); f.model.setStatsInterval(1000);
    let finish!: (rows: Download[]) => void; f.getDownloads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pull = f.model.refresh(); f.model.receiveStats([stats('a', { progress: .8 })]); finish([download('a')]); await pull;
    expect(f.model.store.getState().statsById.get('a')?.progress).toBe(.8);
  });
  it('publishes operation-only changes and stabilizes equal observations without another stats subscription', async () => {
    const { model } = fixture(); await model.refresh();
    const checking = downloadOperation(download('a'), { stage: 'checking', fraction: .2 });
    model.receiveStats([stats('a', { operation: checking })]);
    const before = model.store.getState().statsById.get('a');
    model.receiveStats([stats('a', { operation: structuredClone(checking) })]);
    expect(model.store.getState().statsById.get('a')).toBe(before);
    model.receiveStats([stats('a', { operation: { ...checking, progress: { completed: .3, total: 1 } } })]);
    expect(model.store.getState().statsById.get('a')).not.toBe(before);
    expect(model.store.getState().statsById.get('a')?.operation?.progress?.completed).toBe(.3);
  });
  it('keeps all live values when a newer push arrives during an old DB read', async () => {
    const f = fixture(); await f.model.refresh();
    let resolve!: (value: Download[]) => void;
    f.getDownloads.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.model.refresh();
    const live = stats('a', { progress: .81, downloadedBytes: 90 });
    f.model.receiveStats([live]); resolve([download('a', { progress: .08 })]); await pending;
    expect(f.model.store.getState().byId.get('a')).toMatchObject(live);
  });
  it('does not roll progress back to a DB read started after the last push', async () => {
    const f = fixture(); await f.model.refresh();
    const live = stats('a', { progress: .81, downloadedBytes: 90 });
    f.model.receiveStats([live]);
    f.getDownloads.mockResolvedValueOnce([download('a', { progress: .08, category: 'updated' })]);
    await f.model.refresh();
    expect(f.model.store.getState().byId.get('a')).toMatchObject({ ...live, category: 'updated' });
  });
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
    await model.refresh();
    expect(model.store.getState().byId.get('a')?.progress).toBe(.3);
    const refreshed = model.store.getState().downloads;
    await model.refresh(); expect(model.store.getState().downloads).toBe(refreshed);
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
    expect(f.model.store.getState().downloads).toBe(before.downloads);
    expect(f.model.store.getState().availability).toBe('unavailable');
    f.getDownloads.mockResolvedValueOnce([download('b', { category: 'new', selectedFiles: [1] }), download('a')]);
    await f.model.refresh(); expect(f.model.store.getState().downloads.map(d => d.id)).toEqual(['b', 'a']);
    expect(f.model.store.getState().availability).toBe('ready');
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
