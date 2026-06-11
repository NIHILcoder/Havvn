/**
 * TorrentHunt State Machine
 * 
 * Defines all valid states and transitions for a torrent download.
 * Prevents illegal state changes and provides validation helpers.
 */

import { DownloadStatus } from './types';

/**
 * State Machine Diagram:
 * 
 *   ┌──────────┐
 *   │  queued  │◄────────────────────────────────┐
 *   └────┬─────┘                                 │
 *        │ slot available                        │ resume (no torrent)
 *        ▼                                       │
 *   ┌──────────────┐    pause    ┌──────────┐   │
 *   │ downloading  │────────────►│  paused  │───┘
 *   └──────┬───────┘◄────────────┴──────────┘
 *          │ done           resume (has torrent)
 *          ▼
 *   ┌──────────┐    stop     ┌──────────┐
 *   │ seeding  │────────────►│ completed│
 *   └────┬─────┘             └──────────┘
 *        │ pause                   ▲
 *        ▼                         │ stop
 *   ┌──────────┐                   │
 *   │  paused  │───────────────────┘
 *   └──────────┘   (was seeding)
 * 
 *   Any state except 'removed' can transition to 'error'
 *   Any state can transition to 'removed'
 */

// All possible download statuses (re-export for convenience)
export const DOWNLOAD_STATUSES: readonly DownloadStatus[] = [
  'queued',
  'downloading',
  'paused',
  'completed',
  'seeding',
  'error',
  'removed',
] as const;

/**
 * Valid state transitions map
 * Key: current state
 * Value: array of valid next states
 */
export const STATE_TRANSITIONS: Record<DownloadStatus, readonly DownloadStatus[]> = {
  // 'queued' targets from active/finished states exist to support a force
  // recheck: the torrent is re-queued so WebTorrent re-verifies on-disk data.
  queued: ['downloading', 'paused', 'error', 'removed'],
  downloading: ['queued', 'paused', 'seeding', 'completed', 'error', 'removed'],
  paused: ['queued', 'downloading', 'seeding', 'completed', 'error', 'removed'],
  seeding: ['queued', 'paused', 'completed', 'error', 'removed'],
  completed: ['queued', 'seeding', 'removed'], // Can re-seed or re-check
  error: ['queued', 'downloading', 'removed'], // Can retry (goes back to queue) or resume directly to downloading
  removed: [], // Terminal state
};

/**
 * Check if a state transition is valid
 */
export function isValidTransition(from: DownloadStatus, to: DownloadStatus): boolean {
  if (from === to) return true; // Same state is always valid
  const validNextStates = STATE_TRANSITIONS[from];
  return validNextStates.includes(to);
}

/**
 * Get all valid next states from current state
 */
export function getValidNextStates(current: DownloadStatus): readonly DownloadStatus[] {
  return STATE_TRANSITIONS[current];
}

/**
 * Error thrown when an invalid state transition is attempted
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: DownloadStatus,
    public readonly to: DownloadStatus,
    public readonly downloadId: string
  ) {
    super(`Invalid state transition for download ${downloadId}: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * States that count as "active" for queue management
 */
export const ACTIVE_STATES: readonly DownloadStatus[] = ['downloading'] as const;

/**
 * States that can be resumed
 */
export const RESUMABLE_STATES: readonly DownloadStatus[] = ['paused', 'queued', 'error'] as const;

/**
 * States that can be paused
 */
export const PAUSABLE_STATES: readonly DownloadStatus[] = ['downloading', 'seeding', 'queued'] as const;

/**
 * States that represent finished downloads (successful)
 */
export const FINISHED_STATES: readonly DownloadStatus[] = ['seeding', 'completed'] as const;

/**
 * States from which a force recheck (re-verify on-disk data) is allowed —
 * anything that has, or may have, data on disk worth verifying.
 */
export const RECHECKABLE_STATES: readonly DownloadStatus[] = ['downloading', 'paused', 'seeding', 'completed', 'error'] as const;

/**
 * Check if a download can be force-rechecked
 */
export function canRecheck(status: DownloadStatus): boolean {
  return RECHECKABLE_STATES.includes(status);
}

/**
 * Check if a download is in an active state
 */
export function isActiveState(status: DownloadStatus): boolean {
  return ACTIVE_STATES.includes(status);
}

/**
 * Check if a download can be resumed
 */
export function canResume(status: DownloadStatus): boolean {
  return RESUMABLE_STATES.includes(status);
}

/**
 * Check if a download can be paused
 */
export function canPause(status: DownloadStatus): boolean {
  return PAUSABLE_STATES.includes(status);
}

/**
 * Check if a download is finished (completed or seeding)
 */
export function isFinished(status: DownloadStatus): boolean {
  return FINISHED_STATES.includes(status);
}

/**
 * Get user-friendly status display text
 */
export function getStatusDisplayText(status: DownloadStatus): string {
  const displayMap: Record<DownloadStatus, string> = {
    queued: 'Queued',
    downloading: 'Downloading',
    paused: 'Paused',
    completed: 'Completed',
    seeding: 'Seeding',
    error: 'Error',
    removed: 'Removed',
  };
  return displayMap[status];
}

/**
 * Get status color for UI
 */
export function getStatusColor(status: DownloadStatus): string {
  const colorMap: Record<DownloadStatus, string> = {
    queued: 'var(--color-status-queued)',
    downloading: 'var(--color-status-downloading)',
    paused: 'var(--color-status-paused)',
    completed: 'var(--color-status-completed)',
    seeding: 'var(--color-status-seeding)',
    error: 'var(--color-status-error)',
    removed: 'var(--color-status-removed)',
  };
  return colorMap[status];
}
