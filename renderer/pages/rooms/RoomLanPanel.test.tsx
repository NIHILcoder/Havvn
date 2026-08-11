/**
 * RoomLanPanel / LanPeerPicker / LanDiagnosticsModal — realm + markup guards.
 *
 * Two things are pinned here, and the second is the point of the file.
 *
 * 1. MARKUP, under renderToStaticMarkup with NO jsdom and NO HostWindowProvider.
 *    That harness is the regression test for "nothing in these panels holds a
 *    module-scope document/window reference": every realm read they make happens
 *    inside an effect or a handler (copyIp, the modal's clipboard, the portals),
 *    never during render. Hoisting any of them to render throws here, because
 *    `document` and `window` do not exist in this environment at all.
 *
 * 2. THE TOAST REALM, as source guards. A toast raised from a torn-off panel must
 *    be drawn in THAT window; `import toast from 'react-hot-toast'` is the module
 *    singleton, which dispatches into the default store that only the MAIN
 *    window's <Toaster> subscribes to. The failure is invisible — nothing throws,
 *    the toast simply appears on the monitor the user is not looking at — and it
 *    cannot be observed from static markup, because every toast in these files
 *    fires from a click handler or a promise. A source assertion is therefore the
 *    only thing that can hold the line, and it is exactly the "test asserting no
 *    detachable component imports the singleton" the P3 review asked for.
 *
 *    Scope is deliberately this directory: it is the unit these files belong to,
 *    and every panel in it is detachable. Widen the glob once the
 *    RoomsPage/components halves have adopted the hook.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { RoomLanPanel, type LanStateView } from './RoomLanPanel';
import type { RoomMember } from '../../../shared/types';

const member = (memberId: string, name: string): RoomMember => ({
  memberId,
  name,
  avatarSeed: memberId,
  online: true,
  isSelf: memberId === 'me',
  lastSeen: 0,
  have: [],
  role: 'member',
});

const MEMBERS: RoomMember[] = [member('me', 'Me'), member('p1', 'Mara'), member('p2', 'Ivo')];

const lan = (over: Partial<LanStateView> = {}): LanStateView => ({
  available: true,
  active: false,
  isHost: false,
  participants: [],
  ...over,
});

const render = (over: Partial<LanStateView> = {}, props: Partial<React.ComponentProps<typeof RoomLanPanel>> = {}) =>
  renderToStaticMarkup(
    <RoomLanPanel
      roomId="room-1"
      lan={lan(over)}
      members={MEMBERS}
      selfId="me"
      onStart={() => {}}
      onStop={() => {}}
      {...props}
    />,
  );

describe('RoomLanPanel markup', () => {
  it('renders the idle panel with a Start action and no DOM globals', () => {
    // The whole harness is the assertion: no jsdom, no provider, no throw.
    const html = render();
    expect(html).toContain('class="room-lan"');
    expect(html).toContain('rooms.lan.start');
    expect(html).not.toContain('rooms.lan.stop');
  });

  it('offers Accept instead of Start once the host has admitted us', () => {
    const html = render(
      { selfAdmitted: true, sessionId: 's1' },
      { onAccept: () => {} },
    );
    expect(html).toContain('rooms.lan.accept');
    expect(html).not.toContain('rooms.lan.start');
  });

  it('names why Start is unavailable rather than silently greying it', () => {
    expect(render({ available: false })).toContain('rooms.lan.unavailable');
    expect(render({ suspended: true })).toContain('rooms.lan.suspended');
    expect(render({ blocked: true })).toContain('rooms.lan.busyElsewhere');
  });

  it('shows the self IP and per-peer tiles while a session is live', () => {
    const html = render({
      active: true,
      isHost: true,
      sessionId: 's1',
      selfVip: '100.88.0.1',
      participants: [
        { memberId: 'me', vip: '100.88.0.1', admitted: true, status: 'connected' },
        { memberId: 'p1', vip: '100.88.0.2', admitted: true, status: 'connected', quality: 'good' },
      ],
    });
    expect(html).toContain('rooms.lan.stop');
    expect(html).toContain('100.88.0.1');
    expect(html).toContain('100.88.0.2');
    expect(html).toContain('room-lan-quality q-good');
    // Self is filtered out of the peer grid — it has no LanPeer to measure.
    expect(html.match(/room-lan-person/g)?.length).toBe(1);
  });

  it('never shows a relayed peer as green, and says who is carrying it', () => {
    const html = render({
      active: true,
      sessionId: 's1',
      selfVip: '100.88.0.1',
      participants: [
        // `quality: 'good'` on purpose: the relay cap must beat the measurement.
        { memberId: 'p1', vip: '100.88.0.2', admitted: true, status: 'connected', quality: 'good', relayVia: 'p2' },
      ],
    } as Partial<LanStateView>);
    expect(html).toContain('room-lan-quality q-fair relayed');
    expect(html).not.toContain('q-good');
    expect(html).toContain('room-lan-relay-badge');
    expect(html).toContain('rooms.lan.relayedTitle');
    expect(html).toContain('rooms.lan.relayedPrivacy');
  });

  it('treats an absent relayEnabled as ON — an older build is relaying, not idle', () => {
    const html = render(
      { active: true, sessionId: 's1', selfVip: '100.88.0.1' },
      { onSetRelayEnabled: () => {} },
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('rooms.lan.relayNone');
    expect(html).not.toContain('rooms.lan.relayOff');
  });

  it('reports live forwarding even when the switch has just been turned off', () => {
    const html = render(
      { active: true, sessionId: 's1', selfVip: '100.88.0.1', relayEnabled: false, relayFor: ['p1', 'p2'] },
      { onSetRelayEnabled: () => {} },
    );
    expect(html).toContain('rooms.lan.relaying');
    expect(html).not.toContain('rooms.lan.relayOff');
  });

  it('keeps the picker and the diagnostics report closed, so neither portal is reached', () => {
    // Both overlays createPortal, which react-dom/server throws on. Rendering
    // cleanly is the proof that the panel opens neither during render.
    expect(() => render({}, { onDiagnostics: () => Promise.reject(new Error('x')) })).not.toThrow();
    expect(render({}, { onDiagnostics: () => Promise.reject(new Error('x')) })).toContain('rooms.lan.diagAction');
  });
});

// ── Realm guards (source-level; see the header for why) ─────────────────────
describe('the dock panels in this directory stay in their own realm', () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx')).sort();
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  /** Source with comments stripped — these headers TALK about the globals they
   *  deliberately avoid, and a prose mention must not read as a call site. */
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('covers every component in this directory', () => {
    // Listed as well as globbed: the guards below run over the glob, so a new
    // panel is covered the moment it lands, and this assertion is what makes
    // that arrival visible in review rather than silent.
    expect(files).toEqual([
      'LanDiagnosticsModal.tsx', 'LanPeerPicker.tsx', 'RoomLanPanel.tsx',
      'RoomLanServerWidget.tsx', 'RoomServerPanel.tsx', 'ServerAccessPanel.tsx',
      'ServerBackupPanel.tsx', 'ServerConfigField.tsx', 'ServerConfigForm.tsx',
      'ServerConsole.tsx', 'ServerContentPanel.tsx', 'ServerPlayersPanel.tsx',
      'ServerSchedulePanel.tsx',
    ]);
  });

  it.each(files)(
    '%s never imports the react-hot-toast module singleton',
    (f) => {
      // The singleton dispatches into the default store, which only the MAIN
      // window's <Toaster> subscribes to. A detachable panel must use
      // useHostToast() so its toasts follow it into a torn-off window.
      expect(read(f)).not.toMatch(/^\s*import\s[^;]*from\s+['"]react-hot-toast['"]/m);
    },
  );

  it.each(['LanDiagnosticsModal.tsx', 'RoomLanPanel.tsx', 'RoomServerPanel.tsx'])(
    '%s binds the toast API to its host realm',
    (f) => {
      const src = read(f);
      expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/utils\/hostToast['"]/);
      // The shadowing name matters: it is what keeps every `toast.*` call site
      // below unchanged.
      expect(src).toMatch(/const\s+toast\s*=\s*useHostToast\(\)/);
    },
  );

  it.each(['LanDiagnosticsModal.tsx', 'LanPeerPicker.tsx'])(
    '%s portals its fixed overlay to the OWNING document body',
    (f) => {
      const src = code(f);
      // `.popout-root` and the dock zone both set container-type, which makes
      // them containing blocks for fixed descendants — an in-place backdrop is
      // trapped inside the panel's box. And a bare `document.body` would put the
      // overlay in the main window when the panel is torn off.
      expect(src).toContain('createPortal(');
      expect(src).toContain('host.document.body');
      expect(src).not.toMatch(/(^|[^.\w])document\.body/m);
    },
  );

  it.each(files)(
    '%s holds no module-scope document/window reference',
    (f) => {
      // A top-level `const x = document…` would break the no-jsdom render above,
      // but this catches it at the point it is written rather than three panels
      // later, and it also catches the module-scope capture that renders fine
      // once and then points at a dead window forever.
      //
      // Anchored at column 0, which is what module scope LOOKS like here: an
      // indented `const api = window.api…` is a per-render alias inside a
      // component, and those are fine — the React tree always runs in the main
      // renderer's JS realm, so the preload bridge is reached absolutely on
      // purpose (see the RoomLanPanel header).
      expect(code(f)).not.toMatch(/^(const|let|var)\s+\w+\s*(:[^=]+)?=\s*(document|window)\b/m);
    },
  );
});
