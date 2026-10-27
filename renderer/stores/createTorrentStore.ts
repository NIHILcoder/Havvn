/**
 * Create-torrent session store.
 *
 * Holds the creation stage/progress/result OUTSIDE the page component so it
 * survives navigation: the actual `createTorrent` call and the progress
 * subscription live here, not in CreateTorrentPage. Switching tabs while a
 * torrent is being created no longer loses the progress/result — returning to
 * the page restores it.
 */

import { create } from 'zustand';
import { useCallback } from 'react';
import { CreateTorrentOptions, CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';
import { isTorrentCreationCancelled } from '../../shared/torrent-creation';

interface CreateTorrentDraft {
  sourcePaths: string[];
  name: string;
  comment: string;
  isPrivate: boolean;
  pieceLength: number;
  trackers: string;
  trackersLoaded: boolean;
  trackersEdited: boolean;
  webSeeds: string;
  startSeeding: boolean;
  createdBy: string;
  activeTab: 'basic' | 'trackers' | 'advanced';
  excludedPaths: Set<string>;
  showFileTree: boolean;
  automaticName: string;
}
const emptyDraft = (): CreateTorrentDraft => ({ sourcePaths: [], name: '', comment: '', isPrivate: false,
  pieceLength: 0, trackers: '', trackersLoaded: false, trackersEdited: false, webSeeds: '', startSeeding: true,
  createdBy: 'Havvn', activeTab: 'basic', excludedPaths: new Set(), showFileTree: false, automaticName: '' });

export interface CreateTorrentParams {
  sourcePaths: string[];
  outputPath: string;
  options: CreateTorrentOptions;
  startSeeding: boolean;
  excludePaths?: string[];
}

type Stage = 'setup' | 'creating' | 'success';

interface CreateTorrentState {
  draft: CreateTorrentDraft;
  setDraftField: <K extends keyof CreateTorrentDraft>(key: K, value: CreateTorrentDraft[K] | ((previous: CreateTorrentDraft[K]) => CreateTorrentDraft[K])) => void;
  stage: Stage;
  progress: CreateTorrentProgress | null;
  result: CreateTorrentResult | null;
  error: string | null;
  cancelled: boolean;
  cancelling: boolean;
  seedRetrying: boolean;
  retrySeed: () => Promise<void>;
  requestId: string | null;
  setError: (e: string | null) => void;
  reset: () => void;
  cancel: () => Promise<void>;
  start: (params: CreateTorrentParams) => Promise<{ ok: boolean; cancelled?: boolean; result?: CreateTorrentResult; error?: string }>;
}

let progressSubscribed = false;

export const useCreateTorrentStore = create<CreateTorrentState>((set, get) => {
  // Subscribe once to the main-process progress stream. Kept for the app's
  // lifetime so updates land even when the page is unmounted.
  const ensureSubscription = () => {
    if (progressSubscribed) return;
    progressSubscribed = true;
    window.api.onCreateTorrentProgress((p) => {
      if (get().stage === 'creating' && p.requestId === get().requestId) set({ progress: p });
    });
  };

  return {
    draft: emptyDraft(),
    setDraftField: (key, value) => set(state => ({ draft: { ...state.draft,
      [key]: typeof value === 'function' ? (value as (previous: typeof state.draft[typeof key]) => typeof state.draft[typeof key])(state.draft[key]) : value } })),
    stage: 'setup',
    progress: null,
    result: null,
    error: null,
    cancelled: false,
    cancelling: false,
    seedRetrying: false,
    requestId: null,

    setError: (error) => set({ error }),

    reset: () => { if (get().stage !== 'creating' && !get().seedRetrying) set(state => ({ stage: 'setup', progress: null, result: null, error: null, cancelled: false,
      draft: { ...state.draft, sourcePaths: [], name: '', comment: '', activeTab: 'basic', excludedPaths: new Set(), showFileTree: false, automaticName: '' } })); },

    cancel: async () => {
      const { stage, requestId, cancelling, progress } = get();
      if (stage !== 'creating' || !requestId || cancelling || progress?.stage !== 'hashing') return;
      set({ cancelling: true, error: null });
      try {
        const accepted = await window.api.cancelCreateTorrent(requestId);
        if (get().requestId === requestId && !accepted) set({ cancelling: false });
      } catch (cause) {
        if (get().requestId === requestId) set({ cancelling: false, error: cause instanceof Error ? cause.message : String(cause) });
      }
    },

    retrySeed: async () => {
      const { result, stage, seedRetrying } = get();
      if (stage !== 'success' || seedRetrying || !result?.seedRetryId || result.seedingStatus === 'queued') return;
      set({ seedRetrying: true });
      try {
        const updated = await window.api.retryCreatedTorrentSeed(result.seedRetryId);
        if (get().result === result) set({ result: updated });
      } catch (cause) {
        if (get().result === result) set({ result: { ...result, seedingStatus: 'failed', seedingError: cause instanceof Error ? cause.message : String(cause) } });
      } finally { set({ seedRetrying: false }); }
    },

    start: async (params) => {
      if (get().stage === 'creating' || get().seedRetrying) return { ok: false, error: 'Torrent creation is already in progress' };
      ensureSubscription();
      const requestId = crypto.randomUUID();
      set({ stage: 'creating', requestId, cancelling: false, cancelled: false, result: null, error: null, progress: { requestId, stage: 'hashing', progress: 0, message: 'Initializing...' } });
      try {
        const result = await window.api.createTorrent({ ...params, requestId });
        set({ result, stage: 'success', progress: null, requestId: null, cancelling: false });
        return { ok: true, result };
      } catch (err) {
        if (isTorrentCreationCancelled(err)) {
          set({ stage: 'setup', progress: null, requestId: null, cancelling: false, cancelled: true, error: null });
          return { ok: false, cancelled: true };
        }
        const error = err instanceof Error ? err.message : 'Failed to create torrent';
        set({ error, stage: 'setup', progress: null, requestId: null, cancelling: false });
        return { ok: false, error };
      }
    },
  };
});

/** Stable setters keep page effects from rescanning sources on every edit. */
export function useCreateTorrentDraftField<K extends keyof CreateTorrentDraft>(key: K) {
  const value = useCreateTorrentStore(state => state.draft[key]);
  const setValue = useCallback((next: CreateTorrentDraft[K] | ((previous: CreateTorrentDraft[K]) => CreateTorrentDraft[K])) => {
    useCreateTorrentStore.getState().setDraftField(key, next);
  }, [key]);
  return [value, setValue] as const;
}
