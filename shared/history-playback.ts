import type { TorrentFile } from './types';
export interface HistoryPlaybackFile extends TorrentFile {
  availability: 'local' | 'stream' | 'missing' | 'paused';
}
export interface HistoryPlaybackOptions { transcode?: boolean; audioTrack?: number; startTime?: number }
