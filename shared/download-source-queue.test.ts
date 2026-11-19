import { describe, expect, it } from 'vitest';
import { ADD_QUEUE_LIMIT, parseSourceQueue } from './download-source-queue';
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}`;
describe('explicit add queue', () => {
  it('keeps invalid input visible and deduplicates equivalent magnet encodings', () => {
    const result = parseSourceQueue([magnet('0'.repeat(40)), magnet('A'.repeat(32)), 'javascript:alert(1)', 'https://example.org/file.torrent'].join('\n'));
    expect(result.rows.map(row => row.issue)).toEqual([undefined, 'duplicate', 'invalid', undefined]);
  });
  it('does not silently truncate an oversized selection', () => {
    const result = parseSourceQueue(Array.from({ length: ADD_QUEUE_LIMIT + 1 }, (_, n) => `https://example.org/${n}.torrent`).join('\n'));
    expect(result.overflow).toBe(true); expect(result.rows).toHaveLength(ADD_QUEUE_LIMIT);
  });
  it('keeps Linux paths case-sensitive and hides credentials from visible URL labels', () => {
    const result = parseSourceQueue('https://name:secret@example.org/file.torrent?passkey=private', [{ sourceType: 'torrent_file', sourceUri: '/A.torrent', label: 'A.torrent' }, { sourceType: 'torrent_file', sourceUri: '/a.torrent', label: 'a.torrent' }]);
    expect(result.rows.every(row => !row.issue)).toBe(true); expect(result.rows[2].source!.label).toBe('example.org/file.torrent');
  });
});
