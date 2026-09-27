
export type ExternalPlayerKind = 'default' | 'vlc' | 'mpv';
export interface ExternalPlayerPreferences { kind: ExternalPlayerKind; executable: string | null }
export interface ExternalPlayerConfig extends ExternalPlayerPreferences { available: boolean }
export type ExternalPlayerFailure = 'invalid-file' | 'missing-file' | 'incomplete-file' | 'missing-player' | 'unsupported-player' | 'launch-failed' | 'unavailable' | 'paused-file' | 'excluded-file' | 'stream-player' | 'too-many-streams' | 'too-many-players';
export type ExternalMedia = { ok: true; key: string; name: string; length: number } | { ok: false; reason: ExternalPlayerFailure };
export type ExternalMediaRead = { data: string } | { wait: true } | { reason: ExternalPlayerFailure };
export interface ExternalPlayerSession { id: string; downloadId: string; path: string; kind: 'vlc' | 'mpv' }
export type ExternalPlayerResult = { ok: true; kind: ExternalPlayerKind; startTime: number } | { ok: false; reason: ExternalPlayerFailure };
export type ExternalPlayerChoice = { ok: true; config: ExternalPlayerConfig | null } | { ok: false; reason: ExternalPlayerFailure };
export interface ExternalPlayerApi {
  getConfig: () => Promise<ExternalPlayerConfig>;
  useDefault: () => Promise<ExternalPlayerConfig>;
  choose: () => Promise<ExternalPlayerChoice>;
  open: (id: string, relativePath: string, startTime?: number) => Promise<ExternalPlayerResult>;
  inspect: (id: string, relativePath: string) => Promise<'local' | 'stream' | ExternalPlayerFailure>;
  sessions: () => Promise<ExternalPlayerSession[]>;
  stop: (id: string) => Promise<void>;
}

export function externalStartTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 604800 ? Math.round(value * 1000) / 1000 : 0;
}
