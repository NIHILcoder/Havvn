import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockZone, resolveDockMount, type DockZonePanel } from './DockZone';

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
