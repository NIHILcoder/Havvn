import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';
import { TORRENT_CREATION_CANCELLED } from '../../shared/torrent-creation';

const params = { sourcePaths: ['D:/source'], outputPath: 'D:/out.torrent', options: { announceList: [] }, startSeeding: false };
const result: CreateTorrentResult = { torrentFilePath: params.outputPath, infoHash: 'a'.repeat(40), magnetUri: 'magnet:test', totalSize: 1, pieceCount: 1, pieceLength: 16384 };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let progress: (value: CreateTorrentProgress) => void;
let job: ReturnType<typeof deferred<CreateTorrentResult>>;
let api: { createTorrent: ReturnType<typeof vi.fn>; cancelCreateTorrent: ReturnType<typeof vi.fn>; onCreateTorrentProgress: ReturnType<typeof vi.fn>; retryCreatedTorrentSeed: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules(); job = deferred<CreateTorrentResult>();
  api = { createTorrent: vi.fn(() => job.promise), cancelCreateTorrent: vi.fn(async () => true),
    retryCreatedTorrentSeed: vi.fn(),
    onCreateTorrentProgress: vi.fn(callback => { progress = callback; return () => {}; }) };
  vi.stubGlobal('window', { api });
});
afterEach(() => { vi.unstubAllGlobals(); });
const store = async () => (await import('./createTorrentStore')).useCreateTorrentStore;

it('keeps a complete form draft independently of mounted page subscribers', async () => {
  const s = await store(); const unsubscribe = s.subscribe(() => {});
  s.getState().setDraftField('sourcePaths', params.sourcePaths);
  s.getState().setDraftField('name', 'Custom name'); s.getState().setDraftField('comment', 'Notes');
  s.getState().setDraftField('trackers', ''); s.getState().setDraftField('trackersEdited', true);
  s.getState().setDraftField('excludedPaths', new Set(['D:/source/skip']));
  s.getState().setDraftField('activeTab', 'advanced'); s.getState().setDraftField('isPrivate', true);
  s.getState().setDraftField('pieceLength', 65536); s.getState().setDraftField('webSeeds', 'https://example.org/file');
  s.getState().setDraftField('createdBy', 'Me'); s.getState().setDraftField('startSeeding', false);
  const draft = s.getState().draft; unsubscribe();
  expect(s.getState().draft).toBe(draft);
  expect(s.getState().draft.excludedPaths.has('D:/source/skip')).toBe(true);
  s.getState().setDraftField('name', previous => previous + ' edited');
  expect(s.getState().draft.name).toBe('Custom name edited');
});

it('continues in the background, rejects unrelated progress and prevents resetting a running job', async () => {
  const s = await store(); const task = s.getState().start(params); const requestId = s.getState().requestId!;
  expect(api.createTorrent).toHaveBeenCalledWith({ ...params, requestId });
  progress({ requestId: 'another', stage: 'hashing', progress: .5, message: 'wrong' });
  expect(s.getState().progress?.progress).toBe(0);
  progress({ requestId, stage: 'hashing', progress: .4, message: 'own' });
  expect(s.getState().progress?.progress).toBe(.4);
  s.getState().reset(); expect(s.getState().stage).toBe('creating');
  expect((await s.getState().start(params)).ok).toBe(false);
  job.resolve(result); await task;
  expect(s.getState()).toMatchObject({ stage: 'success', result });
});

it('waits for actual cancellation, retains draft and does not show cancellation as an error', async () => {
  const s = await store(); s.getState().setDraftField('name', 'Keep this');
  const task = s.getState().start(params); const requestId = s.getState().requestId;
  await s.getState().cancel(); await s.getState().cancel();
  expect(api.cancelCreateTorrent).toHaveBeenCalledTimes(1);
  expect(api.cancelCreateTorrent).toHaveBeenCalledWith(requestId);
  expect(s.getState()).toMatchObject({ stage: 'creating', cancelling: true });
  job.reject(new Error(`Error invoking remote method: ${TORRENT_CREATION_CANCELLED}`));
  expect(await task).toEqual({ ok: false, cancelled: true });
  expect(s.getState()).toMatchObject({ stage: 'setup', cancelled: true, cancelling: false, error: null, draft: { name: 'Keep this' } });
});

it('preserves a saved result if cancellation arrived too late', async () => {
  const s = await store(); const task = s.getState().start(params);
  api.cancelCreateTorrent.mockResolvedValue(false); await s.getState().cancel();
  expect(s.getState().cancelling).toBe(false);
  job.resolve(result); expect((await task).ok).toBe(true); expect(s.getState().stage).toBe('success');
});

it('does not offer cancellation during seed verification and keeps partial success', async () => {
  const s = await store(); const task = s.getState().start(params);
  progress({ requestId: s.getState().requestId!, stage: 'verifying', progress: 0, message: 'verify' });
  await s.getState().cancel(); expect(api.cancelCreateTorrent).not.toHaveBeenCalled();
  job.resolve({ ...result, seedingStatus: 'failed', seedingError: 'source missing' }); await task;
  expect(s.getState().result?.seedingStatus).toBe('failed');
});

it('shows a cancellation transport error without pretending that hashing stopped', async () => {
  const s = await store(); const task = s.getState().start(params);
  api.cancelCreateTorrent.mockRejectedValue(new Error('host unavailable')); await s.getState().cancel();
  expect(s.getState()).toMatchObject({ stage: 'creating', cancelling: false, error: 'host unavailable' });
  job.reject(new Error('host unavailable')); await task;
});

it('keeps retry progress/results across navigation and blocks resetting or creating during retry', async () => {
  const s = await store(); const task = s.getState().start(params);
  job.resolve({ ...result, seedingStatus: 'failed', seedRetryId: 'receipt', seedingError: 'first error' }); await task;
  const pending = deferred<CreateTorrentResult>(); api.retryCreatedTorrentSeed.mockReturnValue(pending.promise);
  const retry = s.getState().retrySeed(); await s.getState().retrySeed();
  expect(api.retryCreatedTorrentSeed).toHaveBeenCalledExactlyOnceWith('receipt');
  s.getState().reset(); expect(s.getState().stage).toBe('success');
  expect((await s.getState().start(params)).ok).toBe(false);
  expect(s.getState().result?.torrentFilePath).toBe(result.torrentFilePath);
  pending.resolve({ ...result, seedingStatus: 'queued' }); await retry;
  expect(s.getState()).toMatchObject({ seedRetrying: false, stage: 'success', result: { seedingStatus: 'queued' } });
  expect(api.createTorrent).toHaveBeenCalledTimes(1);
});

it('preserves the saved file, identity and retry token on a failed retry IPC call', async () => {
  const s = await store(); const task = s.getState().start(params);
  job.resolve({ ...result, seedingStatus: 'not-requested', seedRetryId: 'receipt' }); await task;
  api.retryCreatedTorrentSeed.mockRejectedValue(new Error('TORRENT_CREATION_BUSY'));
  await s.getState().retrySeed();
  expect(s.getState().result).toMatchObject({ ...result, seedRetryId: 'receipt', seedingStatus: 'failed', seedingError: 'TORRENT_CREATION_BUSY' });
});
