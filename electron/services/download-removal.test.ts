import { describe, expect, it, vi } from 'vitest';
import type { Download } from '../../shared/types';
import { DownloadUndoFailure, restoreDownloadInMap, type DownloadRemovalSnapshot } from '../../shared/download-removal';
import { DownloadRemovalJournal } from './download-removal';
import { downloadRestoreWarnings } from './download-restore-policy';

const download = (id = 'id'): Download => ({ id, name: id, infoHash: 'a'.repeat(40), sourceType: 'magnet', sourceUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
  torrentFilePath: null, savePath: 'D:/downloads', status: 'paused', progress: .5, downloadedBytes: 50, uploadedBytes: 10,
  downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0, totalSize: 100, priority: 2, category: 'movies',
  selectedFiles: [0], filePriorities: ['high', 'skip'], createdAt: new Date(1), updatedAt: new Date(2), lastError: null });
const snapshot = (id = 'id'): DownloadRemovalSnapshot => ({ download: download(id), signature: 'signature', metadata: null, files: [], existingFiles: [] });
function fixture() {
  let now = 1000, seq = 0;
  const adapter = { capture: vi.fn(async (id: string) => snapshot(id)), remove: vi.fn().mockResolvedValue(undefined), restore: vi.fn().mockResolvedValue({ warnings: [] }) };
  const changed = vi.fn(), journal = new DownloadRemovalJournal(adapter, changed, () => now, () => String(++seq));
  return { adapter, journal, changed, time: (value: number) => { now = value; } };
}
describe('session download undo journal', () => {
  it('captures before deletion, exposes no source/metadata/paths, coalesces undo and records only confirmed success', async () => {
    const f = fixture(); const { undo } = await f.journal.remove('id', false);
    expect(f.adapter.capture.mock.invocationCallOrder[0]).toBeLessThan(f.adapter.remove.mock.invocationCallOrder[0]);
    expect(JSON.stringify(f.journal.state())).not.toMatch(/sourceUri|magnet:|savePath|filePriorities|metadata/);
    let finish!: (value: { warnings: [] }) => void;
    f.adapter.restore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const a = f.journal.undo(undo!.token), b = f.journal.undo(undo!.token); expect(a).toBe(b);
    expect(f.journal.state().items[0].status).toBe('restoring');
    f.time(50_000); expect(f.journal.state().items).toHaveLength(1);
    finish({ warnings: [] }); expect((await a).success).toBe(true);
    expect(await f.journal.undo(undo!.token)).toEqual(await a); expect(f.adapter.restore).toHaveBeenCalledOnce();
    expect(f.journal.state().items[0]).toMatchObject({ status: 'restored', operation: { status: 'succeeded' } });
  });
  it('keeps a failed undo retryable, without turning failure into success or duplicating records', async () => {
    const f = fixture(), { undo } = await f.journal.remove('id', false);
    f.adapter.restore.mockRejectedValueOnce(new DownloadUndoFailure('files-missing'));
    expect(await f.journal.undo(undo!.token)).toEqual({ success: false, error: 'files-missing' });
    expect(f.journal.state().items[0]).toMatchObject({ status: 'failed', error: 'files-missing', operation: { status: 'failed' } });
    expect((await f.journal.undo(undo!.token)).success).toBe(true);
  });
  it('never offers undo for file deletion and still removes a record when a snapshot is unavailable', async () => {
    const f = fixture(); expect(await f.journal.remove('id', true)).toEqual({ undo: null }); expect(f.adapter.capture).not.toHaveBeenCalled();
    f.adapter.capture.mockRejectedValueOnce(new DownloadUndoFailure('metadata-unavailable'));
    expect(await f.journal.remove('id', false)).toEqual({ undo: null, unavailable: 'metadata-unavailable' });
    expect(f.adapter.remove).toHaveBeenCalledTimes(2);
  });
  it('expires snapshots, bounds entries and never offers an undo for a failed deletion', async () => {
    const f = fixture(); f.adapter.remove.mockRejectedValueOnce(new Error('busy'));
    await expect(f.journal.remove('bad', false)).rejects.toThrow(); expect(f.journal.state().items).toHaveLength(0);
    for (let i = 0; i < 25; i++) await f.journal.remove(String(i), false);
    expect(f.journal.state().items).toHaveLength(20);
    const token = f.journal.state().items[0].token;
    f.time(31_001); expect(await f.journal.undo(token)).toEqual({ success: false, error: 'expired' });
    expect(f.journal.state().items).toHaveLength(0);
  });
  it('coalesces repeat removals but does not silently replace a different destructive intent', async () => {
    const f = fixture(), a = f.journal.remove('id', false), b = f.journal.remove('id', false);
    expect(a).toBe(b); await expect(f.journal.remove('id', true)).rejects.toThrow('different removal'); await a;
    expect(f.adapter.capture).toHaveBeenCalledOnce(); expect(f.adapter.remove).toHaveBeenCalledOnce();
  });
});
describe('atomic restored record', () => {
  it('preserves identity, dates and options, rejects ID/hash conflicts and permits a native tombstone', () => {
    const original = download(), records = { id: { ...original, status: 'removed' as const } } as Record<string, Download>;
    const restored = restoreDownloadInMap(records, original, [{ id: 'movies' }]);
    expect(restored).toMatchObject({ id: 'id', category: 'movies', priority: 2, selectedFiles: [0], filePriorities: ['high', 'skip'] });
    expect(restored.createdAt).toEqual(new Date(1)); expect(restored).not.toBe(original);
    expect(() => restoreDownloadInMap(records, original, [])).toThrow(DownloadUndoFailure);
    expect(() => restoreDownloadInMap(records, { ...original, id: 'other' }, [])).toThrow(DownloadUndoFailure);
    expect(restoreDownloadInMap({}, original, []).category).toBeNull();
  });
  it('detects a magnet conflict before metadata arrives even when the hash uses another encoding', () => {
    const current = { ...download('current'), infoHash: undefined, sourceUri: 'magnet:?xt=urn:btih:' + 'A'.repeat(32) };
    expect(() => restoreDownloadInMap({ current }, { ...download(), infoHash: '0'.repeat(40) }, [])).toThrow(DownloadUndoFailure);
  });
});
describe('restore respects current protections', () => {
  const policy = () => ({ settings: vi.fn().mockResolvedValue({ diskGuardEnabled: true, diskGuardMinFreeMB: 100, defaultSeedRatioLimit: 1 }),
    privacy: vi.fn().mockResolvedValue({ vpnKillSwitch: true }), bind: () => null, vpnSafe: vi.fn().mockResolvedValue(true), free: vi.fn().mockResolvedValue(1024 ** 3) });
  it('checks VPN protection for paused verification without requiring space for a new download', async () => {
    const p = policy(); expect(await downloadRestoreWarnings(download(), p)).toEqual([]); expect(p.vpnSafe).toHaveBeenCalledOnce();
    expect(p.free).not.toHaveBeenCalled();
  });
  it('checks live VPN/disk/seed limits after verification and fails closed on unmeasured space', async () => {
    const p = policy(); p.vpnSafe.mockResolvedValue(false); p.free.mockResolvedValue(null);
    const d = { ...download(), status: 'seeding' as const, uploadedBytes: 100 };
    expect(await downloadRestoreWarnings(d, p)).toEqual(['vpn', 'disk', 'seed-limit']);
    p.vpnSafe.mockResolvedValue(true); p.free.mockResolvedValue(1024 ** 3);
    expect(await downloadRestoreWarnings({ ...d, uploadedBytes: 0 }, p)).toEqual([]);
    expect(await downloadRestoreWarnings({ ...d, seedRatioLimit: 0, seedTimeLimitMinutes: 0 }, p)).toEqual([]);
  });
});
