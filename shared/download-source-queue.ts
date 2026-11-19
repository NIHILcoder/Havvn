import { parseDownloadLink, type DownloadLink } from './download-link';
import { extractInfoHashFromMagnet } from './magnet';

export const ADD_QUEUE_LIMIT = 64;
export interface DownloadSource extends DownloadLink { label: string }
export interface SourceQueueRow { key: string; source: DownloadSource | null; value: string; issue?: 'invalid' | 'duplicate' }
export function sourceIdentity(source: DownloadLink): string {
  return extractInfoHashFromMagnet(source.sourceUri) ?? `${source.sourceType}:${source.sourceUri.replace(/\\/g, '/')}`;
}
/** No fetching: each line is explicit input. Invalid and duplicate rows remain visible. */
export function parseSourceQueue(text: string, files: readonly DownloadSource[] = []): { rows: SourceQueueRow[]; overflow: boolean } {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean), seen = new Set<string>();
  const input = [...files.map(source => ({ source, value: source.sourceUri })), ...lines.map(value => {
    const parsed = parseDownloadLink(value); let label = value;
    if (parsed?.sourceType === 'torrent_file') { const url = new URL(parsed.sourceUri); label = `${url.hostname}${url.pathname}`; }
    if (parsed?.sourceType === 'magnet') label = new URL(parsed.sourceUri).searchParams.get('dn') || `Magnet ${extractInfoHashFromMagnet(parsed.sourceUri)?.slice(0, 12)}`;
    return { value, source: parsed ? { ...parsed, label } : null };
  })];
  return { overflow: input.length > ADD_QUEUE_LIMIT, rows: input.slice(0, ADD_QUEUE_LIMIT).map((entry, index) => {
    const identity = entry.source ? sourceIdentity(entry.source) : entry.value;
    const duplicate = seen.has(identity); seen.add(identity);
    return { ...entry, key: `${index}:${identity}`, issue: !entry.source ? 'invalid' : duplicate ? 'duplicate' : undefined };
  }) };
}
