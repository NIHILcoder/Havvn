import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { REAL_HOST, HostWindowProvider, HostWindowRealm, useHostWindow, resolveHostWindow, portalTargetFor, type HostWindow } from './hostWindow';

// These run in Node with NO jsdom, which is half the point: the module must be
// import- AND read-safe where `document`/`window` do not exist, and the pure
// resolvers must work on duck-typed stand-ins for a second window.

const fakeHost = (label: string): HostWindow => {
  const doc = { body: { tag: `body:${label}` } } as unknown as Document;
  const win = { name: label, document: doc } as unknown as Window;
  (doc as unknown as { defaultView: Window }).defaultView = win;
  return { document: doc, window: win };
};

/** An element living in `host`'s document — what `ref.current` looks like. */
const elementIn = (host: HostWindow): Element => ({ ownerDocument: host.document } as unknown as Element);

describe('REAL_HOST — the no-provider default', () => {
  it('does not throw when the globals are absent (getters off globalThis)', () => {
    expect(() => REAL_HOST.document).not.toThrow();
    expect(() => REAL_HOST.window).not.toThrow();
    expect(REAL_HOST.document).toBeUndefined();
  });
});

describe('resolveHostWindow — an element beats the context', () => {
  const ctx = fakeHost('ctx');

  it('takes the element\'s own document and window', () => {
    const own = fakeHost('child');
    const r = resolveHostWindow(elementIn(own), ctx);
    expect(r.document).toBe(own.document);
    expect(r.window).toBe(own.window);
  });

  it('falls back to the context when there is no element yet', () => {
    expect(resolveHostWindow(null, ctx)).toBe(ctx);
    expect(resolveHostWindow(undefined, ctx)).toBe(ctx);
  });

  it('falls back when the element\'s window is gone (defaultView null after close)', () => {
    const stale = { ownerDocument: { defaultView: null } } as unknown as Element;
    expect(resolveHostWindow(stale, ctx)).toBe(ctx);
  });

  it('falls back for an element with no ownerDocument at all', () => {
    expect(resolveHostWindow({} as Element, ctx)).toBe(ctx);
  });
});

describe('portalTargetFor — which body a portal lands in', () => {
  const ctx = fakeHost('ctx');

  it('uses the anchor\'s own body, not the context\'s', () => {
    const own = fakeHost('child');
    expect(portalTargetFor(elementIn(own), ctx)).toBe(own.document.body);
  });

  it('uses the context body when there is no anchor', () => {
    expect(portalTargetFor(null, ctx)).toBe(ctx.document.body);
  });

  it('is safe to evaluate with the DOM-less real host (undefined, never dereferenced)', () => {
    // react-dom/server throws on createPortal anyway, so no tested path consumes
    // this value — but computing it during a server render must not blow up.
    expect(() => portalTargetFor(null, REAL_HOST)).not.toThrow();
    expect(portalTargetFor(null, REAL_HOST)).toBeUndefined();
  });
});

describe('useHostWindow — default vs provider', () => {
  const Probe: React.FC = () => {
    const host = useHostWindow();
    return React.createElement('i', null, host === REAL_HOST ? 'real' : (host.window as unknown as { name: string }).name);
  };

  it('resolves to the real globals when no provider is above (the main window)', () => {
    expect(renderToStaticMarkup(React.createElement(Probe))).toBe('<i>real</i>');
  });

  it('resolves to the provided window inside a torn-off subtree', () => {
    const child = fakeHost('child');
    const tree = React.createElement(HostWindowProvider, { window: child.window, children: React.createElement(Probe) });
    expect(renderToStaticMarkup(tree)).toBe('<i>child</i>');
  });

  it('exposes the provided window\'s own document', () => {
    const child = fakeHost('child');
    let seen: Document | null = null;
    const Peek: React.FC = () => { seen = useHostWindow().document; return null; };
    renderToStaticMarkup(React.createElement(HostWindowProvider, { window: child.window, children: React.createElement(Peek) }));
    expect(seen).toBe(child.document);
  });
});

describe('HostWindowRealm — a host that may change, in a subtree whose shape may not', () => {
  const Probe: React.FC = () => {
    const host = useHostWindow();
    return React.createElement('i', null, host === REAL_HOST ? 'real' : (host.window as unknown as { name: string }).name);
  };

  it('provides the real globals for null, so the docked case is the no-provider case', () => {
    // The hoisted-panel wrapper is UNCONDITIONAL — a conditional provider would
    // change the child's element type on a docked↔window move and React would
    // remount it, which is the exact bug the mount hoist exists to prevent. So the
    // null case must be indistinguishable from having no provider at all.
    expect(renderToStaticMarkup(React.createElement(HostWindowRealm, { window: null, children: React.createElement(Probe) })))
      .toBe('<i>real</i>');
  });

  it('provides REAL_HOST BY IDENTITY for null, not an equivalent copy', () => {
    // ConfirmDialog's resolveDialogRealm decides "render in place" on
    // `provider === REAL_HOST`, so an equal-but-different object here would quietly
    // start portalling every main-window dialog to <body>.
    let seen: HostWindow | null = null;
    const Peek: React.FC = () => { seen = useHostWindow(); return null; };
    renderToStaticMarkup(React.createElement(HostWindowRealm, { window: null, children: React.createElement(Peek) }));
    expect(seen).toBe(REAL_HOST);
  });

  it('provides the child window when the panel is parked in a torn-off slot', () => {
    const child = fakeHost('child');
    expect(renderToStaticMarkup(React.createElement(HostWindowRealm, { window: child.window, children: React.createElement(Probe) })))
      .toBe('<i>child</i>');
    let seen: Document | null = null;
    const Peek: React.FC = () => { seen = useHostWindow().document; return null; };
    renderToStaticMarkup(React.createElement(HostWindowRealm, { window: child.window, children: React.createElement(Peek) }));
    expect(seen).toBe(child.document);
  });

  it('renders the same element type for both realms — the anti-remount contract', () => {
    // Pinning the SHAPE, not just the value: whatever a caller wraps, the wrapper
    // itself is one element type at one position for the whole panel lifetime.
    const child = fakeHost('child');
    const docked = React.createElement(HostWindowRealm, { window: null, children: null });
    const detached = React.createElement(HostWindowRealm, { window: child.window, children: null });
    expect(docked.type).toBe(detached.type);
  });

  it('does not touch the DOM when there is none (import- and render-safe in Node)', () => {
    expect(() => renderToStaticMarkup(React.createElement(HostWindowRealm, { window: null, children: null }))).not.toThrow();
  });
});
