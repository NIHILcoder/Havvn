export interface ServerHealthSample {
  at: number;
  rssBytes?: number;
  /** Percent of the computer's total logical CPU capacity. */
  cpuPercent?: number;
  freeDiskBytes?: number;
  tps?: number;
  mspt?: number;
  tickAt?: number;
  tickSource?: 'spark' | 'paper';
}
export interface ServerHealthState { current: ServerHealthSample | null; history: ServerHealthSample[]; running: boolean; remote: boolean }
export function parseServerHealth(raw: unknown): ServerHealthSample | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.at !== 'number' || !Number.isFinite(p.at) || p.at < 0) return undefined;
  const out: ServerHealthSample = { at: p.at };
  for (const key of ['rssBytes', 'freeDiskBytes', 'cpuPercent', 'tps', 'mspt', 'tickAt'] as const) {
    const value = p[key];
    const max = key === 'cpuPercent' ? 100 : key === 'tps' ? 1000 : key === 'mspt' ? 60_000 : Number.MAX_SAFE_INTEGER;
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return undefined;
      out[key] = value;
    }
  }
  if (p.tickSource === 'spark' || p.tickSource === 'paper') out.tickSource = p.tickSource;
  return out;
}
