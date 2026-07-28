import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The provider reads i18n for its default titles and button labels; markup tests
// don't need real locale loading, so t() just echoes the key.
vi.mock('../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { ConfirmProvider, resolveDialogRealm, dialogRealmWatch, drainRequests } from './ConfirmDialog';
import { REAL_HOST, type HostWindow } from '../utils/hostWindow';

// No jsdom here, which is the point: the realm decision is the part that must be
// provable, and it is a pure function over two duck-typed window/document pairs.

const fakeHost = (label: string, open = true): HostWindow => {
  const doc = { body: { tag: `body:${label}` } } as unknown as Document;
  const win = { name: label, document: doc, closed: !open } as unknown as Window;
  (doc as unknown as { defaultView: Window }).defaultView = win;
  return { document: doc, window: win };
};

/** What REAL_HOST looks like once there is a DOM — the main-window provider. */
const withMainDom = (main: HostWindow, fn: () => void): void => {
  const g = globalThis as { document?: Document; window?: Window };
  const prevDoc = g.document; const prevWin = g.window;
  g.document = main.document; g.window = main.window;
  try { fn(); } finally { g.document = prevDoc; g.window = prevWin; }
};

describe('resolveDialogRealm — which window a queued dialog renders in', () => {
  it('renders IN PLACE for a main-window provider answering its own window', () => {
    // The one case that must not change: no HostWindowProvider above, so the
    // provider IS REAL_HOST, and the requester's document is the same one.
    const main = fakeHost('main');
    withMainDom(main, () => {
      const asProviderSees: HostWindow = { document: main.document, window: main.window };
      expect(resolveDialogRealm(REAL_HOST, REAL_HOST)).toBeNull();
      expect(resolveDialogRealm(REAL_HOST, asProviderSees)).toBeNull();
    });
  });

  it('portals into the requesting window when the panel that asked was torn off', () => {
    const main = fakeHost('main');
    const child = fakeHost('child');
    withMainDom(main, () => {
      expect(resolveDialogRealm(REAL_HOST, child)).toBe(child);
      expect(resolveDialogRealm(REAL_HOST, child)?.document.body).toBe(child.document.body);
    });
  });

  it('portals to <body> even for a same-window request when the PROVIDER is detached', () => {
    // A second provider mounted inside a detached shell sits under .popout-root,
    // which sets container-type and would trap a fixed backdrop inside the panel
    // box. Its own window's <body> is a sibling of that element, so it escapes.
    const child = fakeHost('child');
    expect(resolveDialogRealm(child, child)).toBe(child);
  });

  it('uses the provider\'s own realm when there is no request queued', () => {
    const main = fakeHost('main');
    withMainDom(main, () => {
      expect(resolveDialogRealm(REAL_HOST, null)).toBeNull();
      expect(resolveDialogRealm(REAL_HOST, undefined)).toBeNull();
    });
  });

  it('falls back to the provider when the asking window has closed', () => {
    // The panel was torn off, asked a question, and the user shut the window
    // before answering. Portalling into a dead document would show the dialog to
    // nobody and leave the awaiting caller hanging.
    const main = fakeHost('main');
    withMainDom(main, () => {
      expect(resolveDialogRealm(REAL_HOST, fakeHost('child', false))).toBeNull();
    });
  });

  it('falls back when the requesting document has been torn down', () => {
    const main = fakeHost('main');
    const gutted = { document: { body: null } as unknown as Document, window: {} as Window };
    withMainDom(main, () => {
      expect(resolveDialogRealm(REAL_HOST, gutted)).toBeNull();
    });
  });

  it('is safe with no DOM at all (Node tests) and answers "in place"', () => {
    // REAL_HOST's getters yield undefined here, so nothing is portal-able and
    // renderToStaticMarkup never reaches createPortal (which it cannot render).
    expect(() => resolveDialogRealm(REAL_HOST, REAL_HOST)).not.toThrow();
    expect(resolveDialogRealm(REAL_HOST, REAL_HOST)).toBeNull();
  });

  it('routes a realm-less request to the provider\'s window rather than nowhere', () => {
    // A detached provider asked by a caller with no usable realm of its own: the
    // dialog belongs in the window the provider is in, not lost.
    const child = fakeHost('child');
    expect(resolveDialogRealm(child, REAL_HOST)).toBe(child);
  });
});

describe('dialogRealmWatch — whose death must re-home an open dialog', () => {
  it('watches the torn-off window a dialog is currently drawn in', () => {
    // The dock hoists panels into the MAIN tree, so a detached panel's question is
    // answered by the app-root provider and portalled out. Nothing re-renders that
    // provider when the child window dies, so the fallback in resolveDialogRealm
    // can never take effect without this.
    const main = fakeHost('main');
    const child = fakeHost('child');
    withMainDom(main, () => {
      expect(dialogRealmWatch(REAL_HOST, child)).toBe(child.window);
    });
  });

  it('watches nothing when the dialog renders in place (the whole main window)', () => {
    const main = fakeHost('main');
    withMainDom(main, () => {
      const asProviderSees: HostWindow = { document: main.document, window: main.window };
      expect(dialogRealmWatch(REAL_HOST, asProviderSees)).toBeNull();
      expect(dialogRealmWatch(REAL_HOST, REAL_HOST)).toBeNull();
    });
  });

  it('watches nothing while no dialog is queued', () => {
    const main = fakeHost('main');
    withMainDom(main, () => {
      expect(dialogRealmWatch(REAL_HOST, null)).toBeNull();
      expect(dialogRealmWatch(REAL_HOST, undefined)).toBeNull();
    });
  });

  it('watches nothing when the dialog is in the PROVIDER\'s own window', () => {
    // A provider mounted inside a dock shell portals to its own <body> — but losing
    // that window unmounts the provider, and the unmount drain is that mechanism.
    const child = fakeHost('child');
    expect(dialogRealmWatch(child, child)).toBeNull();
  });

  it('watches nothing once the asking window has already closed', () => {
    // resolveDialogRealm has fallen back to the provider by then, so there is
    // nothing foreign left to lose — and no listener is armed on a dead window.
    const main = fakeHost('main');
    withMainDom(main, () => {
      expect(dialogRealmWatch(REAL_HOST, fakeHost('child', false))).toBeNull();
    });
  });

  it('is safe with no DOM at all (Node tests)', () => {
    expect(() => dialogRealmWatch(REAL_HOST, REAL_HOST)).not.toThrow();
    expect(dialogRealmWatch(REAL_HOST, REAL_HOST)).toBeNull();
  });
});

describe('drainRequests — nothing awaits a dialog that will never render', () => {
  it('answers queued confirms false and resolves queued alerts', () => {
    const answers: (boolean | 'alert')[] = [];
    const queue = [
      { kind: 'confirm' as const, resolve: (v: boolean) => answers.push(v) },
      { kind: 'alert' as const, resolve: () => answers.push('alert') },
      { kind: 'confirm' as const, resolve: (v: boolean) => answers.push(v) },
    ];
    expect(drainRequests(queue)).toBe(3);
    expect(answers).toEqual([false, 'alert', false]);
    expect(queue).toEqual([]);
  });

  it('empties the queue BEFORE settling, so a resolver cannot see a request twice', () => {
    // A resolver that synchronously drains again (a handler that reacts to its
    // own cancellation) must find nothing left rather than re-settle the rest.
    const seen: string[] = [];
    const queue: { kind: 'confirm'; resolve: (v: boolean) => void }[] = [];
    queue.push({ kind: 'confirm', resolve: () => { seen.push('a'); drainRequests(queue); } });
    queue.push({ kind: 'confirm', resolve: () => { seen.push('b'); } });
    drainRequests(queue);
    expect(seen).toEqual(['a', 'b']);
  });

  it('is a no-op on an empty queue', () => {
    expect(drainRequests([])).toBe(0);
  });
});

describe('ConfirmProvider markup', () => {
  it('renders its children and nothing else while no dialog is queued', () => {
    const html = renderToStaticMarkup(
      <ConfirmProvider><span>app</span></ConfirmProvider>,
    );
    expect(html).toBe('<span>app</span>');
    expect(html).not.toContain('um-backdrop');
  });
});
