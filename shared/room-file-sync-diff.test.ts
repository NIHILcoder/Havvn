import { expect, it } from 'vitest';
import { syncTextDiff, SYNC_DIFF_BYTES } from './room-file-sync-diff';
const bytes = (s: string) => new TextEncoder().encode(s);
it('shows literal additions and removals, retaining line numbers and unchanged context', () => {
  const result = syncTextDiff(bytes('a\nlocal\nz\n'), bytes('a\nshared\nz\n'));
  if (result.kind !== 'text') throw new Error('Expected text');
  expect(result.lines.filter(l => l.kind !== 'added').map(l => l.text).join('\n')).toBe('a\nlocal\nz\n');
  expect(result.lines.filter(l => l.kind !== 'removed').map(l => l.text).join('\n')).toBe('a\nshared\nz\n');
  expect(result.lines.find(l => l.kind === 'removed')).toEqual({ kind: 'removed', text: 'local', local: 2, incoming: null });
  expect(result.lines.find(l => l.kind === 'added')).toEqual({ kind: 'added', text: 'shared', local: null, incoming: 2 });
});
it('keeps markup inert and includes BOM and line-ending differences', () => {
  const result = syncTextDiff(bytes('\uFEFF<script>bad()</script>\r\n'), bytes('<script>bad()</script>\n'));
  if (result.kind !== 'text') throw new Error('Expected text');
  expect(result.lines.find(l => l.kind === 'removed')?.text).toBe('\uFEFF<script>bad()</script>\r');
  expect(result.lines.find(l => l.kind === 'added')?.text).toBe('<script>bad()</script>');
});
it('handles absent/empty files and refuses expensive, binary and unsupported encoding previews', () => {
  expect(syncTextDiff(bytes(''), bytes('new'))).toEqual({ kind: 'text', lines: [{ kind: 'added', text: 'new', local: null, incoming: 1 }] });
  expect(syncTextDiff(bytes(''), bytes(''))).toEqual({ kind: 'text', lines: [] });
  expect(syncTextDiff(bytes('text'), bytes('more'), 'sheet.xlsx')).toEqual({ kind: 'unavailable', reason: 'binary' });
  expect(syncTextDiff(new Uint8Array([255]), bytes('a'))).toEqual({ kind: 'unavailable', reason: 'binary' });
  expect(syncTextDiff(bytes('a\0b'), bytes('a'))).toEqual({ kind: 'unavailable', reason: 'binary' });
  expect(syncTextDiff(new Uint8Array(SYNC_DIFF_BYTES + 1), bytes('a'))).toEqual({ kind: 'unavailable', reason: 'large' });
  expect(syncTextDiff(bytes('line\n'.repeat(401)), bytes('a'))).toEqual({ kind: 'unavailable', reason: 'large' });
});
