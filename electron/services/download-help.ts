import type { Download, DownloadStats, TorrentFile } from '../../shared/types';
import type { EffectiveSettingsSnapshot } from '../../shared/effective-settings';
import { explainDownload, type DownloadHelpReport } from '../../shared/download-help';
interface Dependencies {
  download(id: string): Promise<Download | null>;
  stats(): DownloadStats[];
  settings(): Promise<EffectiveSettingsSnapshot>;
  /** Must use the read-only history route, never ensureInDaemon/getFiles. */
  files(id: string): Promise<TorrentFile[]>;
}
export async function inspectDownloadHelp(id: string, deps: Dependencies): Promise<DownloadHelpReport> {
  const before = await deps.download(id);
  if (!before || before.status === 'removed') throw Error('Download not found');
  const [settings, files] = await Promise.all([
    deps.settings().catch(() => null),
    before.totalSize > 0 ? deps.files(id).catch(() => null) : Promise.resolve(null),
  ]);
  const download = await deps.download(id);
  if (!download || download.status === 'removed') throw Error('Download not found');
  const stats = deps.stats().find(row => row.id === id);
  // A selection/location changed while reading; do not explain the new row using old files.
  const same = JSON.stringify([before.infoHash, before.savePath, before.selectedFiles, before.filePriorities, before.updatedAt]) === JSON.stringify([download.infoHash, download.savePath, download.selectedFiles, download.filePriorities, download.updatedAt]);
  return { ...explainDownload(download, stats, settings, same ? files : null), id, name: download.name, error: download.lastError, status: download.status };
}
