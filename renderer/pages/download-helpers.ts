/**
 * Shared formatting + view helpers for the Downloads page and its row component.
 * Extracted so DownloadsPage.tsx and DownloadItem.tsx can both use them without
 * one importing the other.
 */

import { Download } from '../../shared/types';
import { IconName } from '../components';

export type ViewMode = 'compact' | 'detailed';
export type FilterMode = 'all' | 'downloading' | 'completed' | 'paused' | 'error';
export type SortMode = 'name' | 'progress' | 'speed' | 'added';

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const formatSpeed = (bytesPerSecond: number): string => {
  return formatBytes(bytesPerSecond) + '/s';
};

export const formatEta = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return '--';
  if (seconds > 86400) return '> 1 day';

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

export const formatDate = (dateInput: string | Date): string => {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
};

// Pick a content-type icon from the file extension, falling back to the
// torrent's category, then a generic folder (multi-file torrents have no ext).
const TYPE_BY_EXT: Record<string, IconName> = {
  mkv: 'film', mp4: 'film', avi: 'film', mov: 'film', webm: 'film', m4v: 'film', wmv: 'film', flv: 'film', mpg: 'film', mpeg: 'film', ts: 'film', m2ts: 'film',
  mp3: 'music', flac: 'music', wav: 'music', m4a: 'music', aac: 'music', ogg: 'music', opus: 'music', wma: 'music',
  zip: 'package', rar: 'package', '7z': 'package', tar: 'package', gz: 'package', bz2: 'package', xz: 'package',
  iso: 'hard-drive', img: 'hard-drive', bin: 'hard-drive', cue: 'hard-drive', nrg: 'hard-drive', mdf: 'hard-drive',
  exe: 'cpu', msi: 'cpu', apk: 'cpu', dmg: 'cpu', deb: 'cpu', rpm: 'cpu', pkg: 'cpu', appimage: 'cpu',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  pdf: 'file-text', doc: 'file-text', docx: 'file-text', txt: 'file-text', epub: 'file-text', mobi: 'file-text',
};
const TYPE_BY_CATEGORY: Record<string, IconName> = {
  movies: 'film', games: 'gamepad-2', software: 'cpu', music: 'music', other: 'folder',
};
export function getTypeIcon(download: Download): IconName {
  const ext = download.name.includes('.') ? download.name.split('.').pop()!.toLowerCase() : '';
  if (ext && TYPE_BY_EXT[ext]) return TYPE_BY_EXT[ext];
  if (download.category && TYPE_BY_CATEGORY[download.category]) return TYPE_BY_CATEGORY[download.category];
  return 'folder';
}
