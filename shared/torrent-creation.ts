// Electron invoke preserves error messages, but not custom error properties.
export const TORRENT_CREATION_CANCELLED = 'TORRENT_CREATION_CANCELLED';
export function isTorrentCreationCancelled(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TORRENT_CREATION_CANCELLED);
}

/** Keep the creator and its preview on the same piece-size policy. */
export function calculateTorrentPieceLength(totalSize: number): number {
  const thresholds: [number, number][] = [
    [512 * 1024 ** 3, 16 * 1024 ** 2],
    [64 * 1024 ** 3, 4 * 1024 ** 2],
    [16 * 1024 ** 3, 2 * 1024 ** 2],
    [4 * 1024 ** 3, 1024 ** 2],
    [1024 ** 3, 512 * 1024],
    [512 * 1024 ** 2, 256 * 1024],
    [256 * 1024 ** 2, 128 * 1024],
    [128 * 1024 ** 2, 64 * 1024],
    [64 * 1024 ** 2, 32 * 1024],
  ];
  return thresholds.find(([threshold]) => totalSize > threshold)?.[1] ?? 16 * 1024;
}

interface SelectionNode {
  path: string;
  size: number;
  isDirectory: boolean;
  children?: SelectionNode[];
}

/** An excluded directory excludes every descendant, including collapsed rows. */
export function torrentSelectionStats(nodes: SelectionNode[], excludedPaths: ReadonlySet<string>) {
  const stats = { total: 0, excluded: 0, totalSize: 0, excludedSize: 0 };
  const visit = (items: SelectionNode[], parentExcluded: boolean) => {
    for (const node of items) {
      const excluded = parentExcluded || excludedPaths.has(node.path);
      if (node.isDirectory) {
        visit(node.children ?? [], excluded);
      } else {
        stats.total++;
        stats.totalSize += node.size;
        if (excluded) { stats.excluded++; stats.excludedSize += node.size; }
      }
    }
  };
  visit(nodes, false);
  return stats;
}

/** Native pickers/drop paths are absolute. Windows path comparisons ignore case. */
export function torrentSourceKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-z]:\//i.test(normalized + '/') || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** Keep one copy of each source; a selected parent already includes its children. */
export function mergeTorrentSources(existing: string[], added: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of [...existing, ...added]) {
    if (value.trim()) unique.set(torrentSourceKey(value), value);
  }
  const entries = [...unique];
  return entries.filter(([key]) => !entries.some(([parent]) => parent !== key && key.startsWith(parent.endsWith('/') ? parent : parent + '/'))).map(([, value]) => value);
}

/** Blank lines separate tracker tiers. Invalid lines stay visible to the caller. */
export function parseTorrentUrls(text: string, kind: 'tracker' | 'webSeed') {
  const groups: string[][] = [], invalidLines: number[] = [];
  const seen = new Set<string>();
  let group: string[] = [], duplicates = 0;
  const protocols = kind === 'tracker' ? ['udp:', 'http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
  const flush = () => { if (group.length) { groups.push(group); group = []; } };
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) { flush(); return; }
    try {
      const url = new URL(line);
      if (!url.hostname || !protocols.includes(url.protocol)) throw new Error('Unsupported URL');
      if (seen.has(url.href)) { duplicates++; return; }
      seen.add(url.href);
      group.push(line);
    } catch { invalidLines.push(index + 1); }
  });
  flush();
  return { groups, urls: groups.flat(), invalidLines, duplicates };
}
