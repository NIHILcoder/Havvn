import { expect, it, vi } from 'vitest';
import { ExternalWatchQueue } from './external-watch-queue';
import { watchKey, type WatchEntry } from '../../shared/watch-history';
const entry: WatchEntry = { identity: 'hash', downloadId: 'one', title: 'Film', path: 'Film.mp4', fileIndex: 2,
  position: 22, duration: 1000, completed: false, lastOpened: 100, updatedAt: 100 };
const session = { key: watchKey(entry), epoch: 0, revision: 1 };
it('coalesces samples per launch, keeps newer data across racing acknowledgements and restores after restart', () => {
  const write = vi.fn(), q = new ExternalWatchQueue(() => [], write);
  q.push('launch', entry, session); const first = q.list()[0];
  q.push('launch', { ...entry, position: 30, updatedAt: 200 }, session); q.acknowledge([first.id]);
  expect(q.list()).toHaveLength(1); expect(q.list()[0].entry.position).toBe(30);
  const restored = new ExternalWatchQueue(() => write.mock.calls.at(-1)![0], write);
  expect(restored.list()[0].entry.position).toBe(30); restored.acknowledge([restored.list()[0].id]); expect(restored.list()).toEqual([]);
});
it('validates persisted data, bounds pending launches and tolerates disk failures', () => {
  const q = new ExternalWatchQueue(() => [{ id: 'broken', entry, session: { ...session, revision: -1 } }, null], () => { throw Error('disk'); });
  expect(q.list()).toEqual([]);
  q.push('bad', entry, { ...session, key: 'another-file' }); expect(q.list()).toEqual([]);
  for (let i = 0; i < 220; i++) q.push(String(i), { ...entry, position: i }, session);
  expect(q.list()).toHaveLength(200); q.acknowledge(['unknown']); expect(q.list()).toHaveLength(200);
});
