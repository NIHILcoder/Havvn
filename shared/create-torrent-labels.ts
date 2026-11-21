export const TORRENT_PIECE_SIZES = [0, ...Array.from({ length: 11 }, (_, i) => 16 * 1024 * 2 ** i)];
export function formatTorrentBytes(bytes: number, language: string): string {
  const ru = language === 'ru', units = ru ? ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const index = bytes === 0 ? 0 : Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))));
  return `${(bytes / 1024 ** index).toLocaleString(ru ? 'ru' : 'en', { maximumFractionDigits: 2 })} ${units[index]}`;
}
