import type { TorrentFile } from '../../shared/types';

export const torrentFileKey = (file: TorrentFile, position: number) => file.index ?? position;

/** Identical polls should not invalidate the list and its size measurements. */
export function reconcileTorrentFiles(previous: TorrentFile[], incoming: TorrentFile[]): TorrentFile[] {
  let changed = previous.length !== incoming.length;
  const next = incoming.map((file, index) => {
    const old = previous[index];
    if (old && old.index === file.index && old.name === file.name && old.path === file.path
      && old.length === file.length && old.downloaded === file.downloaded
      && old.progress === file.progress && old.priority === file.priority) return old;
    changed = true;
    return file;
  });
  return changed ? next : previous;
}
