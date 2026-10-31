import type { WatchTarget } from './watch-history';
export interface MediaRelocationTarget extends WatchTarget { length: number }
export interface MediaRelocationPreview { token: string; target: MediaRelocationTarget; candidatePath: string; candidateBytes: number; sizeMatches: boolean; formatMatches: boolean; expiresAt: number }
export interface MediaRelocationView { target: MediaRelocationTarget; available: boolean }
