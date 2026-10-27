import { classifyMediaKind } from './media';

export interface PickerFile { index: number; path: string }
export type PickerAction = 'scope-only' | 'video-only' | 'video-subtitles' | 'add-mp4' | 'add-mkv' | 'exclude-sample' | 'exclude-txt' | 'exclude-nfo';
const SUBTITLES = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'smi', 'sami', 'sup', 'ttml', 'dfxp']);
export const pickerPath = (value: string) => value.replace(/\\/g, '/');
export function filesInPickerScope<T extends PickerFile>(files: readonly T[], query: string, folder: string): T[] {
  const search = pickerPath(query).toLowerCase(), normalizedFolder = pickerPath(folder).replace(/\/+$/, ''), prefix = normalizedFolder ? `${normalizedFolder}/` : '';
  return files.filter(file => {
    const path = pickerPath(file.path);
    return (!prefix || path.startsWith(prefix)) && (!search || path.toLowerCase().includes(search));
  });
}
export function pickerFolders(files: readonly PickerFile[]): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = pickerPath(file.path).split('/'); parts.pop();
    let folder = '';
    for (const part of parts) { folder = folder ? `${folder}/${part}` : part; if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1); }
  }
  return [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
}
/** Replacement is restricted to the declared scope; all indices are metadata IDs, never positions. */
export function applyPickerAction(selected: ReadonlySet<number>, scope: readonly PickerFile[], action: PickerAction): Set<number> {
  if (action === 'scope-only') return new Set(scope.map(file => file.index));
  const next = new Set(selected), replace = action === 'video-only' || action === 'video-subtitles';
  for (const file of scope) {
    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    const video = classifyMediaKind(file.path) === 'video';
    const match = action === 'video-only' ? video : action === 'video-subtitles' ? video || SUBTITLES.has(ext)
      : action === 'add-mp4' ? ext === 'mp4' : action === 'add-mkv' ? ext === 'mkv'
      : action === 'exclude-txt' ? ext === 'txt' : action === 'exclude-nfo' ? ext === 'nfo'
      : /(?:^|[/._\s()[\]-])samples?\d*(?=$|[/._\s()[\]-])/i.test(pickerPath(file.path));
    if (replace) { if (match) next.add(file.index); else next.delete(file.index); }
    else if (match) { if (action.startsWith('add-')) next.add(file.index); else next.delete(file.index); }
  }
  return next;
}
