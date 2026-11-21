import type { Download, FilePriority } from './types';

/** Later per-file changes override the subset chosen in the add dialog. */
export function torrentFilePriority(download: Pick<Download, 'selectedFiles' | 'filePriorities'>, index: number, selected?: ReadonlySet<number>): FilePriority {
  const priority = download.filePriorities?.[index];
  if (priority !== undefined) return priority;
  const hasSelection = selected ? selected.size > 0 : !!download.selectedFiles?.length;
  return hasSelection && !(selected ? selected.has(index) : download.selectedFiles!.includes(index)) ? 'skip' : 'normal';
}
