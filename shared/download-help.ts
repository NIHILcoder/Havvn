import type { Download, DownloadStats, TorrentFile } from './types';
import type { EffectiveSettingsSnapshot } from './effective-settings';
import { downloadOperation } from './download-operation';
import { canResume } from './state-machine';

export type DownloadHelpReason = 'removed' | 'failed' | 'disk' | 'vpn' | 'checking' | 'metadata' | 'no-files' | 'selected-complete' | 'paused' | 'queued' | 'finished' | 'no-report' | 'no-peers' | 'unknown' | 'transferring';
export type DownloadHelpAction = 'resume' | 'retry' | 'files' | 'controls' | 'limits' | 'storage' | 'privacy';
export interface DownloadHelpSnapshot {
  reason: DownloadHelpReason;
  actions: DownloadHelpAction[];
  checkedAt: number;
  /** Counts come from the returned file priorities, not selectedFiles (empty means all). */
  selected: number | null;
  totalFiles: number | null;
  peers: number | null;
  rate: number | null;
  settingsKnown: boolean;
  filesKnown: boolean;
}
export interface DownloadHelpReport extends DownloadHelpSnapshot { id: string; name: string; error: string | null; status: Download['status'] }

/** Explain existing observations only. No network diagnosis and no state changes. */
export function explainDownload(download: Download, stats: DownloadStats | undefined, settings: EffectiveSettingsSnapshot | null, files: TorrentFile[] | null, checkedAt = Date.now()): DownloadHelpSnapshot {
  const live = stats?.id === download.id && stats.status === download.status ? stats : undefined;
  const status = live?.status ?? download.status, progress = live?.progress ?? download.progress;
  const operation = live?.operation ?? downloadOperation({ ...download, status, progress }, live ?? {});
  const prioritiesKnown = download.totalSize > 0 && !!files?.length && files.every(file => file.priority !== undefined);
  const selected = prioritiesKnown ? files!.filter(file => file.priority !== 'skip') : null;
  const result: DownloadHelpSnapshot = { reason: 'unknown', actions: ['controls', 'limits'], checkedAt,
    selected: selected?.length ?? null, totalFiles: files?.length ?? null,
    peers: live && Number.isFinite(live.peers) && live.peers >= 0 ? live.peers : null,
    rate: live && Number.isFinite(live.downSpeedBps) && live.downSpeedBps >= 0 ? live.downSpeedBps : null,
    settingsKnown: settings !== null, filesKnown: files !== null };
  const explain = (reason: DownloadHelpReason, actions: DownloadHelpAction[]): DownloadHelpSnapshot => ({ ...result, reason, actions });
  if (status === 'removed') return explain('removed', []);
  if (operation.stage === 'checking') return explain('checking', ['controls']);
  if (status === 'completed' || status === 'seeding') return explain('finished', ['files', 'controls']);
  // A current guard explains what blocks transfer now, not who originally paused this row.
  if (settings?.blocks.includes('disk')) return explain('disk', ['storage', 'limits']);
  if (settings?.blocks.includes('vpn')) return explain('vpn', ['privacy', 'limits']);
  if (status === 'error') return explain('failed', ['controls', 'files', 'retry']);
  if (selected?.length === 0) return explain('no-files', ['files']);
  if (selected?.length && selected.every(file => file.length >= 0 && file.downloaded >= file.length)) return explain('selected-complete', ['files', 'controls']);
  if (status === 'paused') return explain('paused', canResume(status) ? ['resume', 'files', 'limits'] : ['files']);
  if (status === 'queued') return explain('queued', ['controls', 'limits']);
  if (operation.stage === 'metadata') return explain('metadata', ['controls']);
  if (!live) return explain('no-report', ['controls']);
  if (result.rate === null) return explain('no-report', ['controls']);
  if (result.rate > 0) return explain('transferring', ['limits', 'files']);
  if (result.peers === null) return explain('no-report', ['controls']);
  if (result.peers === 0) return explain('no-peers', ['controls', 'limits']);
  return result;
}
