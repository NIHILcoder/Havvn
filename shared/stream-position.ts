/** A finite source timestamp, rounded to milliseconds before it crosses IPC/URLs. */
export function streamStartSeconds(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 7 * 24 * 3600) throw new Error('Invalid stream start time');
  return Math.round(value * 1000) / 1000;
}
export function parseStreamStart(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error('Invalid stream start time');
  return streamStartSeconds(Number(value));
}
export function streamStartParam(value: number): string { const start = streamStartSeconds(value); return start ? `&s=${start}` : ''; }
/** Output-side seeking: pipe input is not seekable, so FFmpeg decodes up to this time. */
export function transcodeSeekArgs(value: number): string[] { const start = streamStartSeconds(value); return start ? ['-ss', String(start)] : []; }
export function transcodeInputArgs(diskPath: string, startTime: number, complete: boolean): string[] {
  const seek = transcodeSeekArgs(startTime);
  // A completed file supports fast input seeking, including MP4 with a tail moov.
  return complete ? [...seek, '-i', diskPath] : ['-i', 'pipe:0', ...seek];
}
