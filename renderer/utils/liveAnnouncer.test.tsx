import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  announcerHub,
  createAnnouncerHub,
  nextAnnouncement,
  EMPTY_ANNOUNCEMENT,
  useAnnounce,
  LiveAnnouncer,
  type AnnouncerState,
} from './liveAnnouncer';
import { HostWindowRealm, REAL_HOST, type HostWindow } from './hostWindow';

// No jsdom: the routing rule and the two-region fold are the parts that must be
// provable, and both are pure. The rendered surface is checked as markup only.

const fakeHost = (label: string): HostWindow => {
  const doc = { body: { tag: `body:${label}` } } as unknown as Document;
  const win = { name: label, document: doc } as unknown as Window;
  (doc as unknown as { defaultView: Window }).defaultView = win;
  return { document: doc, window: win };
};

describe('createAnnouncerHub — the announcement lands in ONE window', () => {
  it('delivers only to the realm that was addressed', () => {
    // The whole point: a panel torn off onto the second monitor must not raise its
    // announcement into the main window's region, where the reader is not.
    const hub = createAnnouncerHub();
    const main = fakeHost('main').window;
    const child = fakeHost('child').window;
    const heardMain: string[] = [];
    const heardChild: string[] = [];
    hub.subscribe(main, (m) => heardMain.push(m));
    hub.subscribe(child, (m) => heardChild.push(m));

    hub.announce(child, 'Chat moved to Centre');

    expect(heardChild).toEqual(['Chat moved to Centre']);
    expect(heardMain).toEqual([]);
  });

  it('reports that nobody was listening rather than pretending it spoke', () => {
    const hub = createAnnouncerHub();
    expect(hub.announce(fakeHost('nowhere').window, 'hello')).toBe(false);
    const main = fakeHost('main').window;
    hub.subscribe(main, () => {});
    expect(hub.announce(main, 'hello')).toBe(true);
  });

  it('says nothing for an empty or whitespace-only message', () => {
    const hub = createAnnouncerHub();
    const heard: string[] = [];
    const win = fakeHost('main').window;
    hub.subscribe(win, (m) => heard.push(m));
    expect(hub.announce(win, '')).toBe(false);
    expect(hub.announce(win, '   ')).toBe(false);
    expect(heard).toEqual([]);
  });

  it('delivers to EVERY region of a realm (StrictMode double-subscribes in dev)', () => {
    const hub = createAnnouncerHub();
    const win = fakeHost('main').window;
    const a: string[] = []; const b: string[] = [];
    hub.subscribe(win, (m) => a.push(m));
    hub.subscribe(win, (m) => b.push(m));
    hub.announce(win, 'x');
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('goes quiet for a realm once its region unsubscribes', () => {
    const hub = createAnnouncerHub();
    const win = fakeHost('child').window;
    const heard: string[] = [];
    const off = hub.subscribe(win, (m) => heard.push(m));
    hub.announce(win, 'first');
    off();
    expect(hub.announce(win, 'second')).toBe(false);
    expect(heard).toEqual(['first']);
    // Unsubscribing twice must not resurrect or throw — a window can die while its
    // host is already unmounting.
    expect(() => off()).not.toThrow();
  });

  it('survives a listener that unsubscribes itself mid-announcement', () => {
    // A dock window closing on the same tick as the move that announced it.
    const hub = createAnnouncerHub();
    const win = fakeHost('child').window;
    const heard: string[] = [];
    const off = hub.subscribe(win, (m) => { heard.push(m); off(); });
    hub.subscribe(win, (m) => heard.push(`b:${m}`));
    expect(() => hub.announce(win, 'x')).not.toThrow();
    expect(heard).toEqual(['x', 'b:x']);
  });

  it('works with the no-DOM realm (undefined) so Node tests can drive it', () => {
    const hub = createAnnouncerHub();
    const heard: string[] = [];
    hub.subscribe(undefined, (m) => heard.push(m));
    expect(hub.announce(undefined, 'x')).toBe(true);
    expect(heard).toEqual(['x']);
  });
});

describe('nextAnnouncement — the same message twice is still announced twice', () => {
  it('writes the first message into the first slot', () => {
    expect(nextAnnouncement(EMPTY_ANNOUNCEMENT, 'Chat moved to Centre'))
      .toEqual({ slots: ['Chat moved to Centre', ''], next: 1 });
  });

  it('alternates slots, so a REPEATED message is always a content change', () => {
    // A screen reader voices a live region when its content changes. Writing the
    // same string into the same node twice is not a change and would be silent —
    // which is exactly what happens when a user moves a panel there, back, and
    // there again.
    let s: AnnouncerState = EMPTY_ANNOUNCEMENT;
    s = nextAnnouncement(s, 'Chat moved to Centre');
    s = nextAnnouncement(s, 'Chat moved to Centre');
    expect(s).toEqual({ slots: ['', 'Chat moved to Centre'], next: 0 });
    s = nextAnnouncement(s, 'Chat moved to Centre');
    expect(s).toEqual({ slots: ['Chat moved to Centre', ''], next: 1 });
  });

  it('clears the other region, so no stale announcement is left to be found', () => {
    let s = nextAnnouncement(EMPTY_ANNOUNCEMENT, 'first');
    s = nextAnnouncement(s, 'second');
    expect(s.slots).toEqual(['', 'second']);
  });

  it('trims, and treats an empty message as no announcement at all (identity)', () => {
    const s = nextAnnouncement(EMPTY_ANNOUNCEMENT, '  padded  ');
    expect(s.slots[0]).toBe('padded');
    expect(nextAnnouncement(s, '')).toBe(s);
    expect(nextAnnouncement(s, '   ')).toBe(s);
  });
});

describe('LiveAnnouncer markup', () => {
  it('renders two empty polite regions and nothing visible', () => {
    const html = renderToStaticMarkup(<LiveAnnouncer />);
    expect(html).toBe(
      '<div class="sr-only" aria-live="polite" aria-atomic="true"></div>'
      + '<div class="sr-only" aria-live="polite" aria-atomic="true"></div>',
    );
  });

  it('is renderable with no DOM at all — no global is touched during render', () => {
    expect(() => renderToStaticMarkup(
      <HostWindowRealm window={fakeHost('child').window}><LiveAnnouncer /></HostWindowRealm>,
    )).not.toThrow();
  });
});

describe('useAnnounce — the realm comes from the host window, not the React tree', () => {
  /** Holds the bound `say` so a test can call it after the render finishes. */
  const box: { say: (m: string) => void } = { say: () => {} };
  const Probe: React.FC = () => { box.say = useAnnounce(); return null; };

  it('addresses the child window for a panel hoisted into a torn-off slot', () => {
    // The dock mounts every panel ONCE in the main React tree and re-parents its
    // DOM into whichever zone claims it, so the nearest React provider is the main
    // one. The realm has to follow the DOM — <HostWindowRealm> is what carries it.
    const child = fakeHost('child');
    renderToStaticMarkup(<HostWindowRealm window={child.window}><Probe /></HostWindowRealm>);

    const heard: string[] = [];
    const off = announcerHub.subscribe(child.window, (m) => heard.push(m));
    box.say('Chat moved to Centre');
    off();
    expect(heard).toEqual(['Chat moved to Centre']);
  });

  it('addresses the real host (the main window) with no realm above it', () => {
    renderToStaticMarkup(<Probe />);

    const heard: string[] = [];
    // REAL_HOST.window is `undefined` here — that IS the main realm in a Node test,
    // and the point is that the hook reads it lazily instead of at import time.
    const off = announcerHub.subscribe(REAL_HOST.window, (m) => heard.push(m));
    box.say('Files moved to Right column');
    off();
    expect(heard).toEqual(['Files moved to Right column']);
  });

  it('does not leak a main-window announcement into a detached panel\'s realm', () => {
    const child = fakeHost('child');
    renderToStaticMarkup(<Probe />);

    const heard: string[] = [];
    const off = announcerHub.subscribe(child.window, (m) => heard.push(m));
    box.say('Files moved to Right column');
    off();
    expect(heard).toEqual([]);
  });
});
