import { describe, it, expect } from 'vitest';

import {
  resolveLiveMounts,
  resolveZoneActive,
  liveMountsIn,
  liveZoneOf,
  type DockMountZone,
} from './dockMounts';

type Id = 'voice' | 'lan' | 'people' | 'files' | 'chat';

const ORDER: Id[] = ['voice', 'lan', 'people', 'files', 'chat'];
/** Matches the real registry: voice, lan and chat opt out of unmount-on-switch. */
const KEEP = (p: Id): boolean => p === 'voice' || p === 'lan' || p === 'chat';

const zone = (zoneId: string, panels: Id[], active: Id | ''): DockMountZone<Id> =>
  ({ zoneId, panels, active });

/** The DEFAULT room: rail = voice/lan/people, centre = files, right = chat. */
const DEFAULT_ZONES: DockMountZone<Id>[] = [
  zone('left', ['voice', 'lan', 'people'], 'voice'),
  zone('centre', ['files'], 'files'),
  zone('right', ['chat'], 'chat'),
];

describe('resolveZoneActive', () => {
  it('repairs a stale active id to the first panel rather than mounting nothing', () => {
    expect(resolveZoneActive(['voice', 'lan'] as Id[], 'chat')).toBe('voice');
    expect(resolveZoneActive(['voice', 'lan'] as Id[], 'lan')).toBe('lan');
  });

  it('is empty only for an empty zone', () => {
    expect(resolveZoneActive([] as Id[], 'voice')).toBe('');
  });
});

describe('resolveLiveMounts — the P1 mount policy, one level up', () => {
  it('mounts the active panel of every zone', () => {
    const live = resolveLiveMounts(DEFAULT_ZONES, () => false, ORDER);
    expect(live.map((m) => m.panel)).toEqual(['voice', 'files', 'chat']);
  });

  it('does NOT mount a non-keep-alive panel that is not its zone active tab', () => {
    // The load-bearing half of the P1 policy: switching tabs still RELEASES the
    // panel you left. Hoisting the mount must not silently make everything alive.
    const live = resolveLiveMounts(DEFAULT_ZONES, () => false, ORDER);
    expect(live.some((m) => m.panel === 'lan')).toBe(false);
    expect(live.some((m) => m.panel === 'people')).toBe(false);
  });

  it('mounts a keep-alive panel EAGERLY, before it has ever been selected', () => {
    // A user whose saved tab is People must still mount the voice panel, or its
    // voice-warning subscription and PTT listeners never exist for that session.
    const zones = [zone('left', ['voice', 'lan', 'people'], 'people')];
    const live = resolveLiveMounts(zones, KEEP, ORDER);
    expect(live.map((m) => m.panel)).toEqual(['voice', 'lan', 'people']);
  });

  it('emits in registry order, not zone order, so portal children never reorder', () => {
    const zones = [
      zone('right', ['chat'], 'chat'),
      zone('left', ['people', 'voice'], 'people'),
      zone('centre', ['files'], 'files'),
    ];
    const live = resolveLiveMounts(zones, KEEP, ORDER);
    expect(live.map((m) => m.panel)).toEqual(['voice', 'people', 'files', 'chat']);
  });

  it('repairs a stale active id the same way the zone does', () => {
    // If the two deciders disagreed the user would get an empty slot or an
    // invisible running panel.
    const zones = [zone('left', ['voice', 'people'], 'chat')];
    const live = resolveLiveMounts(zones, () => false, ORDER);
    expect(live).toEqual([{ panel: 'voice', zoneId: 'left' }]);
  });

  it('mounts nothing for an empty zone and does not throw', () => {
    expect(resolveLiveMounts([zone('left', [], '')], KEEP, ORDER)).toEqual([]);
  });

  it('drops a panel that has left every zone (no leaked mount)', () => {
    const before = resolveLiveMounts([zone('left', ['voice', 'lan'], 'lan')], KEEP, ORDER);
    expect(before.map((m) => m.panel)).toEqual(['voice', 'lan']);
    const after = resolveLiveMounts([zone('left', ['lan'], 'lan')], KEEP, ORDER);
    expect(after.map((m) => m.panel)).toEqual(['lan']);
  });

  it('is history-free: the same layout always resolves to the same set', () => {
    const a = resolveLiveMounts(DEFAULT_ZONES, KEEP, ORDER);
    const b = resolveLiveMounts(DEFAULT_ZONES, KEEP, ORDER);
    expect(a).toEqual(b);
  });

  it('mounts a panel living in a WINDOW zone exactly like a docked one', () => {
    const zones = [
      zone('left', ['people'], 'people'),
      zone('centre', ['files'], 'files'),
      zone('right', [], ''),
      zone('w1', ['voice', 'chat'], 'chat'),
    ];
    const live = resolveLiveMounts(zones, KEEP, ORDER);
    expect(live).toEqual([
      { panel: 'voice', zoneId: 'w1' },
      { panel: 'people', zoneId: 'left' },
      { panel: 'files', zoneId: 'centre' },
      { panel: 'chat', zoneId: 'w1' },
    ]);
  });

  it('resolves a duplicated panel to ONE zone rather than mounting it twice', () => {
    // The model forbids this; a corrupt persisted blob must still yield one mount.
    const zones = [zone('left', ['chat'], 'chat'), zone('right', ['chat'], 'chat')];
    const live = resolveLiveMounts(zones, KEEP, ORDER);
    expect(live).toEqual([{ panel: 'chat', zoneId: 'left' }]);
  });

  it('still mounts a panel the caller forgot to list in `order`', () => {
    const live = resolveLiveMounts(DEFAULT_ZONES, KEEP, ['voice'] as Id[]);
    expect(live.map((m) => m.panel).sort()).toEqual(['chat', 'files', 'lan', 'voice']);
  });
});

// THE architecture proof. If this ever fails, a move remounts the panel again.
describe('a move changes ONLY the moved entry zone', () => {
  it('leaves the panel id — the portal key and container key — untouched', () => {
    const before = resolveLiveMounts(DEFAULT_ZONES, KEEP, ORDER);
    expect(before.map((m) => m.panel)).toEqual(['voice', 'lan', 'files', 'chat']);
    // "Move to ▸ Left column" on Chat — it joins the rail, the right column empties.
    const after = resolveLiveMounts(
      [
        zone('left', ['voice', 'lan', 'people', 'chat'], 'voice'),
        zone('centre', ['files'], 'files'),
        zone('right', [], ''),
      ],
      KEEP,
      ORDER,
    );

    expect(before.map((m) => m.panel)).toEqual(after.map((m) => m.panel));
    for (const m of before) {
      const next = after.find((n) => n.panel === m.panel);
      expect(next).toBeDefined();
      // Every entry but the moved one is identical; the moved one differs ONLY in
      // its zone, so its portal key and its stable container are untouched.
      if (m.panel === 'chat') expect(next?.zoneId).toBe('left');
      else expect(next?.zoneId).toBe(m.zoneId);
    }
  });

  it('survives a TEAR-OFF the same way — same ids, one new zone', () => {
    const before = resolveLiveMounts(DEFAULT_ZONES, KEEP, ORDER);
    const after = resolveLiveMounts(
      [
        zone('left', ['voice', 'lan', 'people'], 'voice'),
        zone('centre', ['files'], 'files'),
        zone('right', [], ''),
        zone('w1', ['chat'], 'chat'),
      ],
      KEEP,
      ORDER,
    );
    expect(before.map((m) => m.panel)).toEqual(after.map((m) => m.panel));
    expect(liveZoneOf(after, 'chat')).toBe('w1');
  });
});

describe('liveMountsIn / liveZoneOf', () => {
  const live = resolveLiveMounts(DEFAULT_ZONES, KEEP, ORDER);

  it('slices the live set per zone for DockZone', () => {
    expect(liveMountsIn(live, 'left')).toEqual(['voice', 'lan']);
    expect(liveMountsIn(live, 'centre')).toEqual(['files']);
    expect(liveMountsIn(live, 'w4')).toEqual([]);
  });

  it('reports where a mounted panel is, and undefined when it is not mounted', () => {
    expect(liveZoneOf(live, 'chat')).toBe('right');
    expect(liveZoneOf(live, 'people')).toBeUndefined();
  });
});
