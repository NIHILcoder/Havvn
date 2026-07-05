import { describe, it, expect } from 'vitest';
import { planRestore, RestorableDownload } from './restore-plan';

type D = RestorableDownload & { id: string };
const d = (id: string, status: string, priority = 0): D => ({ id, status, priority });

describe('planRestore', () => {
  it('brings all seeding torrents live regardless of the download slot limit', () => {
    const { live, requeue } = planRestore([d('a', 'seeding'), d('b', 'seeding'), d('c', 'seeding')], 1);
    expect(live.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    expect(requeue).toEqual([]);
  });

  it('caps live downloads at maxActive and re-queues the overflow', () => {
    const { live, requeue } = planRestore([d('a', 'downloading'), d('b', 'downloading'), d('c', 'downloading')], 2);
    expect(live).toHaveLength(2);
    expect(requeue).toHaveLength(1);
  });

  it('gives live download slots to the HIGHEST priority; re-queues the lowest', () => {
    const { live, requeue } = planRestore(
      [d('low', 'downloading', 0), d('high', 'downloading', 5), d('mid', 'downloading', 2)],
      1,
    );
    expect(live.map((x) => x.id)).toEqual(['high']);
    expect(requeue.map((x) => x.id)).toEqual(['mid', 'low']); // highest-priority claims the slot, rest requeued in priority order
  });

  it('seeding does NOT consume a download slot', () => {
    const { live } = planRestore([d('s', 'seeding'), d('dl1', 'downloading'), d('dl2', 'downloading')], 2);
    expect(live.map((x) => x.id).sort()).toEqual(['dl1', 'dl2', 's']);
  });

  it("leaves 'queued' rows untouched (neither live nor requeued)", () => {
    const { live, requeue } = planRestore([d('q', 'queued'), d('dl', 'downloading')], 5);
    expect(live.map((x) => x.id)).toEqual(['dl']);
    expect(requeue).toEqual([]);
  });

  it('ignores non-restorable states (paused/completed/error/removed)', () => {
    const { live, requeue } = planRestore([d('p', 'paused'), d('c', 'completed'), d('e', 'error'), d('r', 'removed')], 5);
    expect(live).toEqual([]);
    expect(requeue).toEqual([]);
  });

  it('requeues everything when maxActive is 0 (but still restores seeding)', () => {
    const { live, requeue } = planRestore([d('s', 'seeding'), d('dl', 'downloading')], 0);
    expect(live.map((x) => x.id)).toEqual(['s']);
    expect(requeue.map((x) => x.id)).toEqual(['dl']);
  });
});
