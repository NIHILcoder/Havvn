import type { DownloadStatus } from './types';

export interface BufferedRange { start: number; end: number }
export function readBufferedRanges(ranges: Pick<TimeRanges, 'length' | 'start' | 'end'>): BufferedRange[] {
  const result: BufferedRange[] = [];
  try {
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i), end = ranges.end(i);
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) result.push({ start, end });
    }
  } catch { return []; } // A changing TimeRanges snapshot is not proof of availability.
  return result;
}

export function bufferedSecondsAhead(ranges: BufferedRange[], currentTime: number): number {
  if (!Number.isFinite(currentTime) || currentTime < 0) return 0;
  const containing = ranges.find(range => range.start <= currentTime && currentTime < range.end);
  return containing ? Math.max(0, containing.end - currentTime) : 0;
}

export type PlaybackPhase = 'resolving' | 'metadata' | 'preparing' | 'seeking' | 'peers' | 'downloadPaused' | 'downloadError' | 'buffering' | 'paused' | 'ended' | 'playing' | 'networkError' | 'decodeError';
export interface PlaybackSnapshot {
  attached: boolean;
  readyState: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  waiting: boolean;
  errorCode?: number;
}
export interface PlaybackSource { status: DownloadStatus; progress: number; peers: number; metadataPending?: boolean; downSpeedBps: number }

export function playbackPhase(media: PlaybackSnapshot, source: PlaybackSource | null, resolving: boolean, transcoded: boolean): PlaybackPhase {
  if (media.errorCode) return media.errorCode === 2 || media.errorCode === 1 ? 'networkError' : 'decodeError';
  if (media.attached && media.ended) return 'ended';
  if (media.attached && media.seeking) return 'seeking';
  if (media.attached && media.paused && media.readyState >= 2) return 'paused';
  const blocked = resolving || !media.attached || media.waiting || media.readyState < 3;
  if (!blocked) return 'playing';
  if (source?.status === 'error') return 'downloadError';
  if (source?.metadataPending && !media.attached) return 'metadata';
  if (source && source.progress < 1) {
    if (source.status === 'paused') return 'downloadPaused';
    if (source.status === 'downloading' && source.peers === 0) return 'peers';
  }
  if (resolving) return 'resolving';
  if (transcoded && media.readyState < 2) return 'preparing';
  return 'buffering';
}
