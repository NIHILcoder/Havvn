import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The shell mounts ConfirmProvider (invariant F), which calls useTranslation.
// Same stub as Modal/Sidebar/StatusBar use — this harness has no I18nProvider.
vi.mock('../../../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { DockWindowShell, stepDockWindowLiveness } from './DockWindowHost';

// DockWindowHost itself is unreachable from this harness by construction: it is
// nothing but a portal into a window that does not exist here, and
// react-dom/server throws on createPortal. Its two testable halves are split out
// — the liveness rule (pure) and the shell (plain markup).

describe('stepDockWindowLiveness', () => {
  it('does not report a close before the window has ever opened', () => {
    // The host opens a macrotask after mount, so "absent" is the NORMAL first
    // state. Reporting it would dock the group back instantly and make tear-off
    // look like it does nothing at all.
    expect(stepDockWindowLiveness(false, false)).toEqual({ seen: false, closed: false });
  });

  it('arms once the window is present', () => {
    expect(stepDockWindowLiveness(false, true)).toEqual({ seen: true, closed: false });
    expect(stepDockWindowLiveness(true, true)).toEqual({ seen: true, closed: false });
  });

  it('reports the close exactly once', () => {
    const gone = stepDockWindowLiveness(true, false);
    expect(gone).toEqual({ seen: false, closed: true });
    // A second pass over an already-gone window is inert, so the re-render that
    // the resulting dock-back itself causes cannot fire a second one — and a
    // duplicate would try to dock a group back that is already home.
    expect(stepDockWindowLiveness(gone.seen, false)).toEqual({ seen: false, closed: false });
  });

  it('re-arms for the next window in the same pool slot', () => {
    // Slots are recycled (havvn-dock-1 comes back), so "closed once" must not
    // mean "closed forever" for that host.
    const gone = stepDockWindowLiveness(true, false);
    const reopened = stepDockWindowLiveness(gone.seen, true);
    expect(reopened.seen).toBe(true);
    expect(stepDockWindowLiveness(reopened.seen, false).closed).toBe(true);
  });
});

describe('DockWindowShell markup', () => {
  const render = (extra: Partial<React.ComponentProps<typeof DockWindowShell>> = {}) =>
    renderToStaticMarkup(
      <DockWindowShell
        frameName="havvn-dock-1"
        title="Voice"
        subtitle="Movie night"
        dockBackLabel="Dock back"
        onDockBack={() => {}}
        {...extra}
      >
        <div className="dock-zone">zone-goes-here</div>
      </DockWindowShell>,
    );

  it('renders the group inside the window body', () => {
    const html = render();
    expect(html).toContain('data-dock-window="havvn-dock-1"');
    expect(html).toMatch(/class="dock-window-body"><div class="dock-zone">zone-goes-here/);
  });

  it('shows the window title and the room it belongs to', () => {
    const html = render();
    expect(html).toContain('>Voice</span>');
    expect(html).toContain('>Movie night</span>');
  });

  it('drops the subtitle rather than rendering an empty line', () => {
    expect(render({ subtitle: undefined })).not.toContain('dock-window-sub');
  });

  it('gives dock-back a real, named button', () => {
    // Cross-window tab drag is impossible, so this control is the ONLY way home
    // by mouse: it has to be a focusable button announced by name inside the
    // child window, not a bare icon a pointer has to find.
    const html = render();
    expect(html).toMatch(/<button type="button" class="dock-window-btn"[^>]*aria-label="Dock back"/);
    expect(html).toContain('title="Dock back"');
  });

  it('mounts a toast host scoped to THIS window (invariant F)', () => {
    // The whole point of the per-window host: a toast raised by a detached panel
    // must be drawn by this window's toaster, not the main window's. The realm
    // id is the frame name, so two dock windows can never share a store.
    expect(render()).toContain('data-rht-toaster="havvn-dock-1"');
    expect(render({ frameName: 'havvn-dock-3' })).toContain('data-rht-toaster="havvn-dock-3"');
  });

  it('mounts a live region scoped to THIS window (the third realm surface)', () => {
    // A screen reader only voices the live regions of the window its virtual cursor
    // is in, so "Chat moved to Left column" raised by a panel on this monitor has to
    // be spoken here. Two regions, because the announcer alternates them so a
    // REPEATED message still counts as a content change.
    const html = render();
    expect(html.match(/aria-live="polite"/g)).toHaveLength(2);
    expect(html).toMatch(/class="sr-only" aria-live="polite" aria-atomic="true"/);
  });

  it('mounts with no DOM at all', () => {
    // Nothing here may dereference a global at render time: the toast host falls
    // back to rendering in place when there is no body to portal into, and the
    // confirm host has no dialog queued. Same DOM-less discipline as
    // hostWindow.tsx — a throw here would take the whole suite down on import.
    expect(() => renderToStaticMarkup(
      <DockWindowShell
        frameName="havvn-dock-2"
        title="Chat"
        dockBackLabel="Dock back"
        onDockBack={() => {}}
      >
        <div>zone</div>
      </DockWindowShell>,
    )).not.toThrow();
  });
});
