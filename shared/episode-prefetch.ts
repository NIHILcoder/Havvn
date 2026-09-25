export const PREFETCH_MAX_BYTES = 64 * 1024 * 1024;
export interface EpisodePrefetchRequest {
  currentFile: number;
  nextFile: number;
  budgetBytes: number;
  allowExcluded: boolean;
  lease: string;
}
export type EpisodePrefetchState = 'active' | 'ready' | 'skipped' | 'inactive' | 'unsupported';
export interface EpisodePrefetchResult { state: EpisodePrefetchState; bytes: number }

export function validateEpisodePrefetch(value: EpisodePrefetchRequest): void {
  if (!value || !Number.isSafeInteger(value.currentFile) || !Number.isSafeInteger(value.nextFile) ||
      value.currentFile < 0 || value.nextFile < 0 || value.currentFile === value.nextFile ||
      !Number.isSafeInteger(value.budgetBytes) || value.budgetBytes <= 0 || value.budgetBytes > PREFETCH_MAX_BYTES ||
      typeof value.allowExcluded !== 'boolean' || typeof value.lease !== 'string' || !/^[a-z0-9-]{8,80}$/i.test(value.lease)) {
    throw new Error('Invalid episode prefetch request');
  }
}

/** Entire pieces only; the selected range never exceeds the byte budget. */
export function prefetchPieceRange(offset: number, length: number, pieceLength: number, budget: number): { start: number; end: number; bytes: number } | null {
  if (![offset, length, pieceLength, budget].every(Number.isSafeInteger) || offset < 0 || length <= 0 || pieceLength <= 0 || budget <= 0) return null;
  const start = Math.floor(offset / pieceLength);
  const count = Math.floor(Math.min(budget, PREFETCH_MAX_BYTES) / pieceLength);
  if (!count) return null;
  const end = Math.min(start + count - 1, Math.floor((offset + length - 1) / pieceLength));
  return { start, end, bytes: (end - start + 1) * pieceLength };
}

export function shouldPrefetchEpisode(input: { enabled: boolean; paused: boolean; seeking: boolean; readyState: number; time: number; duration: number; bufferSeconds: number }): boolean {
  return input.enabled && !input.paused && !input.seeking && input.readyState >= 3 &&
    Number.isFinite(input.duration) && input.duration > 0 && Number.isFinite(input.time) && input.time > 0 &&
    input.duration - input.time > 0 && input.duration - input.time <= 180 && input.bufferSeconds >= 20;
}
