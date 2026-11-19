import { expect, it, vi } from 'vitest';
import type { CreateTorrentRequest, CreateTorrentResult } from '../../shared/types';
import { TorrentCreationService } from './torrent-creation';
import { TORRENT_CREATION_CANCELLED } from '../../shared/torrent-creation';
const request: CreateTorrentRequest = { requestId: 'owned', sourcePaths: ['D:/source'], outputPath: 'D:/saved.torrent', options: { announceList: [] }, startSeeding: true };
const result = (): CreateTorrentResult => ({ torrentFilePath: request.outputPath, infoHash: 'a'.repeat(40), magnetUri: 'magnet:test', totalSize: 1, pieceLength: 16384, pieceCount: 1 });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it('cancels only the active owner/request and holds the lock until cleanup finishes', async () => {
  const pending = deferred<CreateTorrentResult>();
  const creator = { createTorrentFile: vi.fn(() => pending.promise), cancelTorrentCreation: vi.fn(async () => true), addSeed: vi.fn() };
  const service = new TorrentCreationService(creator, vi.fn());
  const job = service.create(1, request); const rejected = expect(job).rejects.toThrow(TORRENT_CREATION_CANCELLED);
  expect(await service.cancel(2, 'owned')).toBe(false); expect(await service.cancel(1, 'stale')).toBe(false);
  expect(creator.cancelTorrentCreation).not.toHaveBeenCalled();
  expect(await service.cancel(1, 'owned')).toBe(true);
  await expect(service.create(1, request)).rejects.toThrow(/already in progress/);
  pending.reject(new Error(TORRENT_CREATION_CANCELLED)); await rejected;
  expect(creator.addSeed).not.toHaveBeenCalled();
  creator.createTorrentFile.mockResolvedValueOnce(result());
  expect((await service.create(1, request)).seedingStatus).toBe('queued');
});

it('keeps a saved result and protects seed verification from late cancellation', async () => {
  const seed = deferred<unknown>(), progress = vi.fn();
  const creator = { createTorrentFile: vi.fn(async () => result()), cancelTorrentCreation: vi.fn(async () => false), addSeed: vi.fn(() => seed.promise) };
  const service = new TorrentCreationService(creator, progress);
  const job = service.create(1, request); await vi.waitFor(() => expect(creator.addSeed).toHaveBeenCalled());
  expect(await service.cancel(1, 'owned')).toBe(false);
  expect(creator.cancelTorrentCreation).not.toHaveBeenCalled();
  await expect(service.create(1, request)).rejects.toThrow(/already in progress/);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'owned', stage: 'verifying' }));
  seed.reject(new Error('verification failed'));
  expect(await job).toMatchObject({ torrentFilePath: request.outputPath, seedingStatus: 'failed', seedingError: 'verification failed' });
});

it('does not seed when not requested and survives a closed progress view', async () => {
  const creator = { createTorrentFile: vi.fn(async () => result()), cancelTorrentCreation: vi.fn(async () => false), addSeed: vi.fn(async () => {}) };
  const service = new TorrentCreationService(creator, () => { throw Error('closed'); });
  expect((await service.create(1, { ...request, startSeeding: false })).seedingStatus).toBe('not-requested');
  expect(creator.addSeed).not.toHaveBeenCalled();
  expect((await service.create(1, request)).seedingStatus).toBe('queued');
});

it('retries the pinned saved result without recreating it, and rejects another owner', async () => {
  const creator = { createTorrentFile: vi.fn(async () => result()), cancelTorrentCreation: vi.fn(async () => false), addSeed: vi.fn().mockRejectedValueOnce(new Error('first failure')).mockResolvedValue({}) };
  const service = new TorrentCreationService(creator, vi.fn());
  const input = structuredClone(request);
  const saved = await service.create(1, input); const token = saved.seedRetryId!;
  expect(saved).toMatchObject({ seedingStatus: 'failed', seedingError: 'first failure' });
  input.sourcePaths[0] = 'D:/other'; input.options.announceList.push(['https://other.example']);
  saved.torrentFilePath = 'D:/forged.torrent'; saved.infoHash = 'b'.repeat(40);
  await expect(service.retrySeed(2, token)).rejects.toThrow('TORRENT_SEED_RETRY_EXPIRED');
  await expect(service.retrySeed(1, 'invented')).rejects.toThrow('TORRENT_SEED_RETRY_EXPIRED');
  const seeded = await service.retrySeed(1, token);
  expect(creator.createTorrentFile).toHaveBeenCalledTimes(1);
  expect(creator.addSeed).toHaveBeenLastCalledWith(expect.objectContaining({ sourcePaths: request.sourcePaths, torrentFilePath: request.outputPath, expectedInfoHash: 'a'.repeat(40), announceList: [], retryExisting: true }));
  expect(seeded).toMatchObject({ seedingStatus: 'queued', torrentFilePath: request.outputPath });
  expect(seeded.seedingError).toBeUndefined(); expect(seeded.seedRetryId).toBeUndefined();
  await service.retrySeed(1, token); expect(creator.addSeed).toHaveBeenCalledTimes(2);
});

it('serializes retry against duplicate clicks and creation, retaining a failed receipt', async () => {
  const pending = deferred<unknown>();
  const creator = { createTorrentFile: vi.fn(async () => result()), cancelTorrentCreation: vi.fn(async () => false), addSeed: vi.fn(() => pending.promise) };
  const service = new TorrentCreationService(creator, vi.fn());
  const saved = await service.create(1, { ...request, startSeeding: false });
  const first = service.retrySeed(1, saved.seedRetryId!);
  await expect(service.retrySeed(1, saved.seedRetryId!)).rejects.toThrow('TORRENT_CREATION_BUSY');
  await expect(service.create(1, request)).rejects.toThrow(/already in progress/);
  expect(await service.cancel(1, saved.seedRetryId!)).toBe(false);
  pending.reject(new Error('still unavailable'));
  expect(await first).toMatchObject({ seedingStatus: 'failed', seedRetryId: saved.seedRetryId, torrentFilePath: saved.torrentFilePath });
  creator.addSeed.mockResolvedValueOnce({});
  expect((await service.retrySeed(1, saved.seedRetryId!)).seedingStatus).toBe('queued');
});

it('bounds retained receipts and reports eviction without starting a seed', async () => {
  const creator = { createTorrentFile: vi.fn(async () => result()), cancelTorrentCreation: vi.fn(async () => false), addSeed: vi.fn(async () => {}) };
  const service = new TorrentCreationService(creator, vi.fn());
  const first = await service.create(1, { ...request, startSeeding: false });
  for (let i = 0; i < 100; i++) await service.create(1, { ...request, startSeeding: false });
  await expect(service.retrySeed(1, first.seedRetryId!)).rejects.toThrow('TORRENT_SEED_RETRY_EXPIRED');
  expect(creator.addSeed).not.toHaveBeenCalled();
});
