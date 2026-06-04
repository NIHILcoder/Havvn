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
import { CreateTorrentOptions, CreateTorrentProgress, CreateTorrentResult } from '../../shared/types';

export interface CreateTorrentParams {
  sourcePaths: string[];
  outputPath: string;
  options: CreateTorrentOptions;
  startSeeding: boolean;
  excludePaths?: string[];
}

type Stage = 'setup' | 'creating' | 'success';

interface CreateTorrentState {
  stage: Stage;
  progress: CreateTorrentProgress | null;
  result: CreateTorrentResult | null;
  error: string | null;
  setError: (e: string | null) => void;
  reset: () => void;
  start: (params: CreateTorrentParams) => Promise<{ ok: boolean; result?: CreateTorrentResult; error?: string }>;
}

let progressSubscribed = false;

export const useCreateTorrentStore = create<CreateTorrentState>((set, get) => {
  // Subscribe once to the main-process progress stream. Kept for the app's
  // lifetime so updates land even when the page is unmounted.
  const ensureSubscription = () => {
    if (progressSubscribed) return;
    progressSubscribed = true;
    window.api.onCreateTorrentProgress((p) => {
      if (get().stage === 'creating') set({ progress: p });
    });
  };

  return {
    stage: 'setup',
    progress: null,
    result: null,
    error: null,

    setError: (error) => set({ error }),

    reset: () => set({ stage: 'setup', progress: null, result: null, error: null }),

    start: async (params) => {
      ensureSubscription();
      set({ stage: 'creating', error: null, progress: { stage: 'hashing', progress: 0, message: 'Initializing...' } });
      try {
        const result = await window.api.createTorrent(params);
        set({ result, stage: 'success' });
        return { ok: true, result };
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Failed to create torrent';
        set({ error, stage: 'setup', progress: null });
        return { ok: false, error };
      }
    },
  };
});
