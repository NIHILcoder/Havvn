import { expect, it } from 'vitest';
import { syncPathExclusion, validSyncExclusions } from './room-file-sync-filters';
it.each([
  ['*.log', 'a.log', true], ['*.log', 'folder/a.LOG', true], ['*.log', 'a.log/data.txt', true], ['*.log', 'a.log.txt', false],
  ['cache/**', 'cache', true], ['cache/**', 'cache/a/b.txt', true], ['cache/**', 'src/cache/a.txt', false],
  ['**/cache/**', 'src/cache/a.txt', true], ['**/cache/**', 'cache/a.txt', true], ['**/cache/**', 'cache2/a.txt', false],
  ['notes/private.md', 'notes/private.md', true], ['notes/private.md', 'other/notes/private.md', false],
  ['**/a?.txt', 'nested/a😀.txt', true], ['**/a?.txt', 'a12.txt', false], ['**/a?.txt', 'ab.txt', true],
  ['a/**/b/*.txt', 'a/b/x.txt', true], ['a/**/b/*.txt', 'a/one/two/b/x.txt', true], ['a/**/b/*.txt', 'c/a/b/x.txt', false],
  ['a/**/b', 'a/x/b/c.txt', true], ['cache', 'x/cache/a.txt', true], ['café/*', 'cafe\u0301/a.txt', true],
])('matches %s against %s: %s', (rule, file, matches) => {
  expect(validSyncExclusions([rule])).toBe(true); expect(syncPathExclusion(file, [rule])?.reason === 'rule').toBe(matches);
});
it.each([null, 'a', {}, [1], new Array(1), [''], [' ../x'], ['../x'], ['/absolute'], ['C:/file'], ['a\\b'], ['a//b'], ['a/'], ['!x'], ['[ab]'], ['{a,b}'], ['a**b'], ['a\nb'], ['a\0b'], ['A', 'a'], ['café', 'cafe\u0301'], Array.from({ length: 65 }, (_, n) => 'file' + n), ['a'.repeat(257)]])('rejects invalid patterns %j', rules => {
  expect(validSyncExclusions(rules)).toBe(false);
});
it('preserves permanent and built-in exclusions and bounds adversarial wildcard matching', () => {
  expect(validSyncExclusions([])).toBe(true);
  expect(syncPathExclusion('.havvn-local/copy-1/a.txt', ['**'])).toEqual({ reason: 'system' });
  expect(syncPathExclusion('src/.git/config', ['**'])).toEqual({ reason: 'default' });
  expect(syncPathExclusion('secret.key', ['**'])).toEqual({ reason: 'default' });
  const rule = Array(16).fill('**').join('/'); expect(validSyncExclusions([rule])).toBe(true);
  expect(syncPathExclusion(Array(16).fill('abcdefgh').join('/'), [rule])?.reason).toBe('rule');
  expect(validSyncExclusions(Array.from({ length: 40 }, (_, n) => n + 'x'.repeat(230)))).toBe(false);
});
