import type { Download, DownloadStatus } from './types';
import { operationProgress, type OperationState } from './operations';

export interface DownloadActivity {
  stage?: 'metadata' | 'checking' | 'transfer';
  /** Engine-measured fraction of metadata received or disk verification performed. */
  fraction?: number;
  checkQueued?: boolean;
  peers?: number;
  downSpeedBps?: number;
}
export function downloadOperation(
  download: Pick<Download, 'status' | 'totalSize' | 'progress'>,
  activity: DownloadActivity = {},
): OperationState {
  const status: DownloadStatus = download.status;
  const stage = activity.stage ?? (download.totalSize > 0 ? 'transfer' : 'metadata');
  const result: OperationState = { stage, status: 'running', progress: stage === 'transfer' && download.totalSize > 0 ? operationProgress(download.progress, 1) : null, waitingFor: null,
    actions: [], lastResult: stage === 'checking' ? { status: 'succeeded', stage: 'metadata' } : null };
  if (status === 'error') return { ...result, status: 'failed', actions: ['retry', 'inspect'], lastResult: { status: 'failed', stage } };
  if (status === 'removed') return { ...result, status: 'cancelled', lastResult: { status: 'cancelled', stage } };
  // A finished row can still be undergoing verification. Do not display its old 100% as check progress.
  if (stage === 'checking') return { ...result, status: activity.checkQueued ? 'waiting' : 'running',
    waitingFor: activity.checkQueued ? 'check-slot' : null,
    progress: activity.checkQueued ? null : operationProgress(activity.fraction ?? NaN, 1), actions: ['inspect'] };
  if (status === 'paused') return { ...result, status: 'waiting', waitingFor: 'paused', actions: ['resume'] };
  if (status === 'completed' || status === 'seeding') return { ...result, stage: 'finished', status: 'succeeded',
    progress: operationProgress(1, 1), lastResult: { status: 'succeeded', stage: 'finished' }, actions: ['inspect'] };
  if (status === 'queued') return { ...result, stage: 'queued', status: 'waiting', waitingFor: 'download-slot', actions: ['pause', 'inspect'] };
  if (stage === 'metadata') return { ...result, status: 'waiting', waitingFor: activity.stage === 'metadata' ? 'metadata-peers' : 'engine',
    progress: operationProgress(activity.fraction ?? NaN, 1), actions: ['pause', 'inspect'] };
  // A zero rate with connected peers does not prove why a swarm is waiting.
  const waitingFor = activity.downSpeedBps === undefined ? 'engine'
    : activity.downSpeedBps > 0 ? null : activity.peers === 0 ? 'peers' : 'unknown';
  return { ...result, status: waitingFor ? 'waiting' : 'running', waitingFor,
    progress: download.totalSize > 0 ? operationProgress(download.progress, 1) : null, actions: ['pause', 'inspect'],
    lastResult: activity.stage === 'transfer' ? { status: 'succeeded', stage: 'checking' } : null };
}
