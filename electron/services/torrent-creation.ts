import { randomUUID } from 'node:crypto';
import type { CreateTorrentRequest, CreateTorrentResult, CreateTorrentProgress } from '../../shared/types';

interface Creator {
  createTorrentFile(request: CreateTorrentRequest): Promise<CreateTorrentResult>;
  cancelTorrentCreation(requestId: string): Promise<boolean>;
  addSeed(request: { sourcePaths: string[]; name?: string; announceList: string[][]; pieceLength?: number; torrentFilePath: string; expectedInfoHash: string; retryExisting?: boolean }): Promise<unknown>;
}
interface SeedReceipt { owner: number; request: CreateTorrentRequest; result: CreateTorrentResult }

/** One creation through hashing and optional seed verification, owned by its caller. */
export class TorrentCreationService {
  private active?: { owner: number; requestId: string; saving: boolean };
  private receipts = new Map<string, SeedReceipt>();
  constructor(private readonly creator: Creator, private readonly progress: (value: CreateTorrentProgress) => void) {}

  cancel(owner: number, requestId: string): Promise<boolean> {
    const active = this.active;
    if (!active || active.owner !== owner || active.requestId !== requestId || active.saving) return Promise.resolve(false);
    return this.creator.cancelTorrentCreation(requestId);
  }

  private async seed(receipt: SeedReceipt, retryExisting: boolean): Promise<CreateTorrentResult> {
    const { request, result } = receipt;
    try {
      await this.creator.addSeed({ sourcePaths: [...request.sourcePaths], name: request.options.name,
        announceList: request.options.announceList.map(tier => [...tier]), pieceLength: request.options.pieceLength,
        torrentFilePath: result.torrentFilePath, expectedInfoHash: result.infoHash, retryExisting });
      receipt.result = { ...result, seedingStatus: 'queued', seedingError: undefined, seedRetryId: undefined };
    } catch (cause) {
      receipt.result = { ...result, seedingStatus: 'failed', seedingError: cause instanceof Error ? cause.message : String(cause) };
    }
    return { ...receipt.result };
  }

  async retrySeed(owner: number, seedRetryId: string): Promise<CreateTorrentResult> {
    const receipt = this.receipts.get(seedRetryId);
    if (!receipt || receipt.owner !== owner) throw new Error('TORRENT_SEED_RETRY_EXPIRED');
    // A repeated completed command is harmless and does not start another seed.
    if (receipt.result.seedingStatus === 'queued') return { ...receipt.result };
    if (this.active) throw new Error('TORRENT_CREATION_BUSY');
    const active = { owner, requestId: seedRetryId, saving: true };
    this.active = active;
    try { return await this.seed(receipt, true); }
    finally { if (this.active === active) this.active = undefined; }
  }

  async create(owner: number, input: CreateTorrentRequest): Promise<CreateTorrentResult> {
    if (this.active) throw new Error('Torrent creation is already in progress');
    const requestId = input?.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error('Invalid creation request ID');
    // Keep the creation snapshot, never a mutable renderer draft or arbitrary
    // file paths supplied by a later retry command.
    const request = structuredClone({ ...input, requestId });
    const active = { owner, requestId, saving: false };
    this.active = active;
    try {
      const result = await this.creator.createTorrentFile(request);
      active.saving = true;
      result.seedingStatus = 'not-requested';
      const seedRetryId = randomUUID();
      const receipt: SeedReceipt = { owner, request, result: { ...result, seedRetryId } };
      this.receipts.set(seedRetryId, receipt);
      while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
      if (request.startSeeding && result.torrentFilePath) {
        try { this.progress({ requestId, stage: 'verifying', progress: 0, message: 'Verifying source files for seeding...' }); } catch { /* Closing the view cannot lose a saved file. */ }
        return await this.seed(receipt, false);
      }
      return { ...receipt.result };
    } finally { if (this.active === active) this.active = undefined; }
  }
}
