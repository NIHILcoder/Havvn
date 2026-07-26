import { describe, it, expect } from 'vitest';

import { isStylesheetNode, absolutizedHref } from './popout';

// The pop-out hook itself needs two real windows to exercise, but the two
// decisions the <head> mirroring rests on are pure — and they are the ones that
// silently break a detached panel (an unstyled React.lazy chunk, or a stylesheet
// whose relative href cannot resolve against about:blank).
// Importing this module in a DOM-less Node run is itself the assertion that
// nothing here touches `document`/`window` at load time.

describe('isStylesheetNode — what gets mirrored into the child head', () => {
  const el = (nodeName: string, attrs: Record<string, string> = {}): Node =>
    ({ nodeType: 1, nodeName, getAttribute: (n: string) => attrs[n] ?? null } as unknown as Node);

  it('mirrors an inline <style> — the dev/HMR and CSS-in-JS case', () => {
    expect(isStylesheetNode(el('STYLE'))).toBe(true);
  });

  it('mirrors <link rel="stylesheet">, case-insensitively and inside a multi-token rel', () => {
    expect(isStylesheetNode(el('LINK', { rel: 'stylesheet' }))).toBe(true);
    expect(isStylesheetNode(el('LINK', { rel: 'StyleSheet' }))).toBe(true);
    expect(isStylesheetNode(el('LINK', { rel: 'preload stylesheet' }))).toBe(true);
  });

  it('ignores non-stylesheet links, other elements, text nodes and nothing at all', () => {
    expect(isStylesheetNode(el('LINK', { rel: 'icon' }))).toBe(false);
    expect(isStylesheetNode(el('LINK'))).toBe(false);
    expect(isStylesheetNode(el('SCRIPT'))).toBe(false);
    expect(isStylesheetNode({ nodeType: 3, nodeName: '#text' } as unknown as Node)).toBe(false);
    expect(isStylesheetNode(null)).toBe(false);
    expect(isStylesheetNode(undefined)).toBe(false);
  });

  it('does not rely on instanceof, so a node from another realm still matches', () => {
    // A cross-realm <link> fails `instanceof HTMLLinkElement`; the structural test
    // is what keeps the mirroring correct once panels live in child windows.
    const crossRealm = Object.create(null) as Record<string, unknown>;
    crossRealm.nodeType = 1;
    crossRealm.nodeName = 'LINK';
    crossRealm.getAttribute = () => 'stylesheet';
    expect(isStylesheetNode(crossRealm as unknown as Node)).toBe(true);
  });
});

describe('absolutizedHref — the child is about:blank, relative hrefs die there', () => {
  it('carries the source link\'s already-resolved href', () => {
    // Reading `.href` off a real <link> yields the absolute URL — that IS the
    // absolutisation; the clone only has to be given the result.
    expect(absolutizedHref({ nodeName: 'LINK', href: 'http://localhost:9000/main.css' }))
      .toBe('http://localhost:9000/main.css');
    expect(absolutizedHref({ nodeName: 'link', href: 'file:///C:/app/dist/renderer/main.css' }))
      .toBe('file:///C:/app/dist/renderer/main.css');
  });

  it('has nothing to carry for an inline <style>', () => {
    expect(absolutizedHref({ nodeName: 'STYLE' })).toBeNull();
  });

  it('treats an empty or missing href as nothing to set', () => {
    expect(absolutizedHref({ nodeName: 'LINK', href: '' })).toBeNull();
    expect(absolutizedHref({ nodeName: 'LINK' })).toBeNull();
    expect(absolutizedHref(null)).toBeNull();
    expect(absolutizedHref(undefined)).toBeNull();
  });
});
