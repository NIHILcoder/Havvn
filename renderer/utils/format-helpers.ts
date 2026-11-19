/**
 * Formatting helpers for displaying values
 */

/**
 * Turn a thrown value (often an Electron IPC error) into a clean, user-facing
 * message. Electron wraps handler errors as
 *   "Error invoking remote method 'downloads:add': Error: <real message>"
 * which is noise to the user — strip the wrapper and the leading "Error:".
 */
export const cleanError = (e: unknown): string => {
  let msg = e instanceof Error ? e.message : String(e ?? '');
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/i, '');
  msg = msg.replace(/^(Error:\s*)+/i, '');
  return msg.trim() || 'Unknown error';
};

/**
 * Format bytes to human-readable size
 */
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(2)} ${sizes[i]}`;
};

/**
 * Speed display units (Settings → Interface). Module-level cache so the hot
 * formatSpeed path never touches localStorage; live numbers repaint on the
 * next stats tick after a change.
 *  - binary: ×1024, KB/s (the historical default)
 *  - si:     ×1000, KB/s
 *  - bits:   ×1000, Kbit/s / Mbit/s (bytes × 8)
 */
export type SpeedUnits = 'binary' | 'si' | 'bits';

let speedUnits: SpeedUnits = (() => {
  try {
    const v = localStorage.getItem('speedUnits');
    return v === 'si' || v === 'bits' ? v : 'binary';
  } catch { return 'binary'; }
})();

export const getSpeedUnits = (): SpeedUnits => speedUnits;

export const setSpeedUnits = (units: SpeedUnits): void => {
  speedUnits = units;
  try { localStorage.setItem('speedUnits', units); window.dispatchEvent(new Event('havvn:device-local')); } catch { /* cosmetic */ }
};
if (typeof window !== 'undefined') window.addEventListener('storage', e => {
  if (e.key !== null && e.key !== 'speedUnits') return;
  try { const v = localStorage.getItem('speedUnits'); speedUnits = v === 'si' || v === 'bits' ? v : 'binary'; } catch { /* optional storage */ }
});

/**
 * Format speed to human-readable, honoring the configured units.
 */
export const formatSpeed = (bytesPerSecond: number): string => {
  if (speedUnits === 'bits') {
    const bits = bytesPerSecond * 8;
    if (bits === 0) return '0 bit/s';
    const k = 1000;
    const sizes = ['bit/s', 'Kbit/s', 'Mbit/s', 'Gbit/s'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bits) / Math.log(k)));
    return `${(bits / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  if (bytesPerSecond === 0) return '0 B/s';
  const k = speedUnits === 'si' ? 1000 : 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytesPerSecond) / Math.log(k)));
  const value = bytesPerSecond / Math.pow(k, i);

  return `${value.toFixed(2)} ${sizes[i]}`;
};

/**
 * Format duration to human-readable
 */
export const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${Math.floor(seconds)} sec`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0
      ? `${hours}h ${minutes}m`
      : `${hours}h`;
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours > 0
    ? `${days}d ${hours}h`
    : `${days}d`;
};
