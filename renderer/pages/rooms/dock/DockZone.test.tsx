import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockZone, resolveDockMount, type DockZonePanel, type DockZoneMounts } from './DockZone';
import { createDockMountRegistry } from './dockMountRegistry';

// DockZone takes its labels pre-translated, so there is no i18n context to mock.

type Id = 'voice' | 'lan' | 'people';

const PANELS: DockZonePanel<Id>[] = [
  { id: 'voice', label: 'Voice' },
  { id: 'lan', label: 'LAN' },
  { id: 'people', label: 'People' },
];

const body = (id: string) => <div className={`body-${id}`}>{`content:${id}`}</div>;

// The mount policy is the load-bearing decision in DockZone (P1 = unmount on
// switch, with an opt-in keep-alive escape hatch). It is stateful across switches,
// which renderToStaticMarkup cannot exercise — hence the pure resolver.
describe('resolveDockMount', () => {
  it('mounts only the active panel', () => {
    const r = resolveDockMount(PANELS, 'lan');
    expect(r.mounted).toEqual(['lan']);
    expect(r.alive).toEqual([]);
  });

  it('repairs an activeId that is not in the zone to the first panel', () => {
    const r = resolveDockMount(PANELS, 'ghost' as Id);
    expect(r.activeId).toBe('voice');
    expect(r.mounted).toEqual(['voice']);
  });

  it('degrades to nothing rather than throwing when a zone has no panels', () => {
    const r = resolveDockMount([] as DockZonePanel<Id>[], 'voice');
    expect(r.activeId).toBe('');
    expect(r.mounted).toEqual([]);
  });

  it('mounts a keep-alive panel EAGERLY and keeps it after switching away', () => {
    const panels: DockZonePanel<Id>[] = [
      { id: 'voice', label: 'Voice', keepAlive: true },
      { id: 'lan', label: 'LAN' },
      { id: 'people', label: 'People' },
    ];
    // Never visited, but keepAlive ⇒ mounted from the very first resolve. Lazy
    // mounting would mean a user whose saved tab is People never mounts the voice
    // panel at all, silently losing its voice-warning subscription and PTT
    // listeners — behaviour that was always-on before the rail became a dock.
    const first = resolveDockMount(panels, 'people');
    expect(first.mounted).toEqual(['voice', 'people']);
    expect(first.alive).toEqual(['voice']);

    // Selecting it changes nothing about its liveness.
    const second = resolveDockMount(panels, 'voice', first.alive);
    expect(second.alive).toEqual(['voice']);

    // Switched away: still mounted (hidden), and panel order is preserved.
    const third = resolveDockMount(panels, 'lan', second.alive);
    expect(third.mounted).toEqual(['voice', 'lan']);
    expect(third.activeId).toBe('lan');
  });

  it('does not keep a non-keep-alive panel mounted after switching away', () => {
    const a = resolveDockMount(PANELS, 'voice');
    const b = resolveDockMount(PANELS, 'lan', a.alive);
    expect(b.mounted).toEqual(['lan']);
  });

  it('prunes a keep-alive id once the panel leaves the zone', () => {
    const panels: DockZonePanel<Id>[] = [{ id: 'voice', label: 'Voice', keepAlive: true }, { id: 'lan', label: 'LAN' }];
    const seen = resolveDockMount(panels, 'voice').alive;
    expect(seen).toEqual(['voice']);
    // A later phase moves 'voice' to another zone — the mount must not leak.
    const moved = resolveDockMount([{ id: 'lan', label: 'LAN' }] as DockZonePanel<Id>[], 'lan', seen);
    expect(moved.alive).toEqual([]);
    expect(moved.mounted).toEqual(['lan']);
  });
});

describe('DockZone markup', () => {
  const render = (activeId: Id, extra: Partial<React.ComponentProps<typeof DockZone<Id>>> = {}) =>
    renderToStaticMarkup(
      <DockZone<Id>
        zoneId="rail"
        panels={PANELS}
        activeId={activeId}
        onSelect={() => {}}
        renderPanel={body}
        ariaLabel="Rail panels"
        className="room-col-rail"
        {...extra}
      />,
    );

  it('keeps the host framing class on the zone root', () => {
    const html = render('voice');
    // .room-col-rail carries the border, brackets and overflow:hidden — the zone
    // reuses it instead of reinventing the frame.
    expect(html).toMatch(/class="dock-zone dock-zone-rail room-col-rail"[^>]*data-dock-zone="rail"/);
  });

  it('renders a tablist and only the active panel body', () => {
    const html = render('lan');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('content:lan');
    expect(html).not.toContain('content:voice');
    expect(html).not.toContain('content:people');
  });

  it('pairs the panel to its tab with matching ids', () => {
    const html = render('lan');
    expect(html).toContain('id="dock-rail-tab-lan"');
    expect(html).toContain('aria-controls="dock-rail-panel-lan"');
    expect(html).toMatch(/id="dock-rail-panel-lan"[^>]*role="tabpanel"/);
    expect(html).toContain('aria-labelledby="dock-rail-tab-lan"');
  });

  it('puts the panel in the tab order after the roving strip', () => {
    expect(render('voice')).toMatch(/class="dock-panel dock-panel-voice"[^>]*tabindex="0"/);
  });

  it('drops the strip and the dangling tabpanel role for a lone panel', () => {
    const html = renderToStaticMarkup(
      <DockZone<Id>
        zoneId="rail"
        panels={[{ id: 'people', label: 'People' }]}
        activeId="people"
        onSelect={() => {}}
        renderPanel={body}
        ariaLabel="Rail panels"
        hideSingleTab
      />,
    );
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).toContain('content:people');
  });

  it('still shows the strip for a lone panel unless asked not to', () => {
    const html = renderToStaticMarkup(
      <DockZone<Id>
        zoneId="rail"
        panels={[{ id: 'people', label: 'People' }]}
        activeId="people"
        onSelect={() => {}}
        renderPanel={body}
        ariaLabel="Rail panels"
      />,
    );
    expect(html).toContain('role="tablist"');
  });
});

// P4 — the solo rule that gives the untouched default room its pre-dock look back.
describe('DockZone solo-host zones', () => {
  const solo = (id: Id, soloHostIds?: readonly Id[]) =>
    renderToStaticMarkup(
      <DockZone<Id>
        zoneId="centre"
        panels={[{ id, label: id }]}
        activeId={id}
        onSelect={() => {}}
        renderPanel={body}
        ariaLabel="Centre panels"
        soloHostIds={soloHostIds}
      />,
    );

  it('hides the strip for a ONE-panel zone whose panel hosts its own handle', () => {
    // The centre column already draws "SHARED FILES · N" as an 11px/700 uppercase
    // eyebrow, and .dock-tabstrip is styled as that same eyebrow. A one-tab strip
    // above it is ~26px + a border of pure duplication.
    const html = solo('people', ['people']);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).toContain('content:people');
  });

  it('keeps the strip for a panel that renders no header of its own', () => {
    // Otherwise a solo Voice column would have NO way out: the zone body is a drop
    // target, never a drag source.
    expect(solo('voice', ['people'])).toContain('role="tablist"');
    expect(solo('people')).toContain('role="tablist"');
  });

  it('keeps the strip as soon as the zone holds more than one panel', () => {
    const html = renderToStaticMarkup(
      <DockZone<Id>
        zoneId="centre"
        panels={[{ id: 'people', label: 'People' }, { id: 'lan', label: 'LAN' }]}
        activeId="people"
        onSelect={() => {}}
        renderPanel={body}
        ariaLabel="Centre panels"
        soloHostIds={['people']}
      />,
    );
    expect(html).toContain('role="tablist"');
  });
});

// P4 — the hoisted path. Bodies are mounted once by the owner and portalled in;
// the zone renders the SLOT and nothing else.
describe('DockZone hoisted mounts', () => {
  const slotRef = () => () => {};
  const hoisted = (activeId: Id, mounted: Id[]) =>
    renderToStaticMarkup(
      <DockZone<Id>
        zoneId="rail"
        panels={PANELS}
        activeId={activeId}
        onSelect={() => {}}
        mounts={{ mounted, slotRef }}
        ariaLabel="Rail panels"
        className="room-col-rail"
      />,
    );

  it('renders the slot with the SAME markup the inline path rendered', () => {
    const html = hoisted('lan', ['lan']);
    expect(html).toContain('id="dock-rail-panel-lan"');
    expect(html).toMatch(/id="dock-rail-panel-lan"[^>]*role="tabpanel"/);
    expect(html).toContain('aria-labelledby="dock-rail-tab-lan"');
    expect(html).toMatch(/class="dock-panel dock-panel-lan"[^>]*tabindex="0"/);
    expect(html).toContain('data-dock-panel="lan"');
  });

  it('renders no body at all — the mount lives outside this subtree', () => {
    const html = hoisted('lan', ['lan']);
    expect(html).not.toContain('content:lan');
    expect(html).toMatch(/id="dock-rail-panel-lan"[^>]*><\/div>/);
  });

  it('hides a mounted-but-inactive slot instead of dropping it', () => {
    const html = hoisted('lan', ['voice', 'lan']);
    expect(html).toContain('id="dock-rail-panel-voice"');
    expect(html).toMatch(/id="dock-rail-panel-voice"[^>]*hidden/);
    expect(html).not.toMatch(/id="dock-rail-panel-lan"[^>]*hidden/);
  });

  it('emits slots in TAB order, whatever order the owner resolved them in', () => {
    // DOM order, focus order and tab order have to be the same order.
    const html = hoisted('voice', ['people', 'voice']);
    expect(html.indexOf('dock-rail-panel-voice')).toBeLessThan(html.indexOf('dock-rail-panel-people'));
  });

  it('never renders a slot for a panel this zone does not hold', () => {
    // The owner's live set covers EVERY zone; a slot for someone else's panel would
    // duplicate a DOM id and a tabpanel.
    const html = hoisted('voice', ['voice', 'chat' as Id]);
    expect(html).not.toContain('dock-rail-panel-chat');
  });

  it('accepts the mount registry straight, with no cast at the wiring site', () => {
    // A COMPILE-TIME pin (this file is typechecked; *.test.ts is not). If the two
    // halves of the hoist ever drift, the room would need a cast to wire them —
    // which is exactly how a ref contract silently rots.
    const reg = createDockMountRegistry<Id>({
      createElement: () => { throw new Error('not reached'); },
    });
    const mounts: DockZoneMounts<Id> = { mounted: ['voice'], slotRef: reg.slotRef };
    expect(mounts.mounted).toEqual(['voice']);
  });

  it('takes precedence over renderPanel when a caller supplies both', () => {
    const html = renderToStaticMarkup(
      <DockZone<Id>
        zoneId="rail"
        panels={PANELS}
        activeId="lan"
        onSelect={() => {}}
        renderPanel={body}
        mounts={{ mounted: ['lan'], slotRef }}
        ariaLabel="Rail panels"
      />,
    );
    expect(html).not.toContain('content:lan');
  });
});

describe('DockZone hidden', () => {
  const render = (extra: Partial<React.ComponentProps<typeof DockZone<Id>>> = {}) =>
    renderToStaticMarkup(
      <DockZone<Id>
        zoneId="centre"
        panels={PANELS}
        activeId="voice"
        onSelect={() => {}}
        renderPanel={body}
        ariaLabel="Centre panels"
        {...extra}
      />,
    );

  it('hides the zone WITHOUT unmounting it, so the stage overlay cannot kill it', () => {
    const html = render({ hidden: true });
    expect(html).toMatch(/class="dock-zone dock-zone-centre"[^>]*hidden/);
    // everything the zone owns is still there
    expect(html).toContain('role="tablist"');
    expect(html).toContain('content:voice');
  });

  it('adds no hidden attribute by default', () => {
    expect(render()).not.toMatch(/class="dock-zone dock-zone-centre"[^>]*hidden/);
  });

  it('renders no live region of its own', () => {
    // Announcements go through the realm-routed announcer (utils/liveAnnouncer),
    // whose region is mounted ONCE PER WINDOW — by the app root for the main
    // window and by DockWindowShell for a torn-off one. A region per zone would
    // mean three in the main window and a second delivery path to keep in step.
    expect(render()).not.toContain('aria-live');
  });
});
