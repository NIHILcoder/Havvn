/**
 * Pop-out window hook — detach a piece of UI into its own OS window.
 *
 * Mirrors the theme editor's proven pattern: window.open('about:blank', <name>)
 * (allowed per-frameName by main.ts setWindowOpenHandler; every child is locked
 * down + closed with the owner there), then the caller portals its JSX into the
 * child. The React tree stays in the MAIN window's realm — state, IPC
 * subscriptions and refs keep working; only the DOM moves.
 *
 * Handled here (the fiddly parts):
 * - a real ROOT element in the child (`.popout-root`) instead of portalling
 *   straight into <body>: it is where the host-window provider mounts and where
 *   `container-type` is established, so a torn-off panel sizes to ITS OWN box;
 * - `portal(children)` — the only supported way to render into the child. It
 *   wraps the subtree in HostWindowProvider, so a detached panel's portals,
 *   listeners and viewport clamps resolve to the child window automatically;
 * - stylesheet cloning (dev <style> tags AND prod <link>s — hrefs absolutized,
 *   the child's base URL is about:blank where relative hrefs don't resolve),
 *   kept LIVE by a <head> observer so a lazily-loaded chunk's CSS still arrives;
 * - mirroring the root html attributes (inline token overrides, data-theme,
 *   data-density, data-reduce-motion) via MutationObserver so theming follows;
 * - beforeunload → treat as closed (fires on close AND navigate; a navigated
 *   child keeps the window name but loses the portal DOM, so force-close it);
 * - pagehide/unmount cleanup so a child never outlives its JS context.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HostWindowProvider } from './hostWindow';

const MIRROR_ATTRS = ['style', 'data-theme', 'data-density', 'data-reduce-motion'];

const SHEET_SELECTOR = 'style, link[rel="stylesheet"]';

/**
 * Pure + duck-typed (no `instanceof`): which <head> nodes must be mirrored into a
 * child window. Kept structural so it is unit-testable without a DOM and so it
 * cannot be fooled by a node from another realm, where `instanceof HTMLLinkElement`
 * is false even for a genuine <link>.
 */
export function isStylesheetNode(node: Node | null | undefined): boolean {
  if (!node || node.nodeType !== 1 /* ELEMENT_NODE */) return false;
  const el = node as Element;
  const tag = el.nodeName.toLowerCase();
  if (tag === 'style') return true;
  if (tag !== 'link') return false;
  const rel = el.getAttribute?.('rel') ?? '';
  return rel.toLowerCase().split(/\s+/).includes('stylesheet');
}

/**
 * Pure: the href to carry over to the clone, or null for a node that has none.
 * The absolutisation is the DOM's own: reading `.href` off the SOURCE <link>
 * resolves it against the MAIN document's base URL — the only document where it
 * resolves, since the child is about:blank and a relative href would 404 there.
 * (Reflected as an attribute on the clone, which is what `clone.href = …` did.)
 */
export function absolutizedHref(node: { nodeName?: string; href?: string } | null | undefined): string | null {
  if (!node || (node.nodeName ?? '').toLowerCase() !== 'link') return null;
  return node.href || null;
}

function cloneSheet(node: Element): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  const href = absolutizedHref(node as unknown as { nodeName?: string; href?: string });
  if (href) clone.setAttribute('href', href);
  return clone;
}

/**
 * Structural CSS for the child window. Room/panel cosmetics stay in the app's own
 * stylesheets — those are cloned in wholesale, so `.popout-root` rules can live
 * next to the panel they style.
 *
 * CONTAINMENT NOTE: `container-type` makes .popout-root a containing block for
 * position:fixed DESCENDANTS. That is safe here — and only here — because every
 * floating surface in a torn-off panel portals to `ownerDocument.body`, i.e. to a
 * SIBLING of this element, never a descendant (the chat's react-palette, the file
 * context menu, the lightbox, DropdownMenu's `portal` prop, ProfileCard, and every
 * Modal wrapped by its caller). If a future panel renders a position:fixed overlay
 * IN PLACE, it will position against this box instead of the window — which looks
 * almost right and is very hard to spot. Portal it out instead.
 * The container is deliberately NOT named `room`: `room` means "the whole
 * three-region room page", which does not exist in a child window, and its absence
 * is what keeps the page-flow/stacking rules out of here.
 */
const BASE_CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--color-bg-primary); }
.popout-root { height: 100%; min-height: 0; display: flex; flex-direction: column; container-type: inline-size; }
`;

export interface Popout {
  /** The child window, or null while docked. Prefer `portal()` over touching it. */
  popout: Window | null;
  /** The child's `.popout-root` element — the portal target and query container. */
  root: HTMLElement | null;
  /**
   * Render `children` into the child window with the host-window provider mounted,
   * or null while docked/closed. Call sites read `return portal(view) ?? view;`.
   */
  portal: (children: React.ReactNode) => React.ReactPortal | null;
  openPopout: () => boolean;
  closePopout: () => void;
}

/**
 * @param containerName optional `container-name` for `.popout-root`, so rules
 * written as `@container <name> (…)` for the docked panel keep matching once it is
 * torn off. Omit for an anonymous container (unnamed `@container` queries still
 * bind to it).
 */
export function usePopout(frameName: string, title: string, containerName?: string): Popout {
  const [popout, setPopout] = useState<Window | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const popoutRef = useRef<Window | null>(null);
  useEffect(() => { popoutRef.current = popout; }, [popout]);

  // source <head> node → its clone in the child, so a REMOVED stylesheet can be
  // removed there too (and so the initial pass is not re-cloned by the observer).
  const clonesRef = useRef<Map<Node, HTMLElement>>(new Map());
  // The base reset stays LAST in the child's head; late clones insert before it.
  const baseRef = useRef<HTMLStyleElement | null>(null);

  const openPopout = (): boolean => {
    const existing = popoutRef.current;
    if (existing && !existing.closed) { existing.focus(); return true; }
    const w = window.open('about:blank', frameName);
    if (!w) return false; // blocked / denied by the window-open handler
    w.document.title = title;
    const clones = clonesRef.current;
    clones.clear();
    for (const node of Array.from(document.querySelectorAll(SHEET_SELECTOR))) {
      const clone = cloneSheet(node);
      clones.set(node, clone);
      w.document.head.appendChild(clone);
    }
    const base = w.document.createElement('style');
    base.textContent = BASE_CSS;
    w.document.head.appendChild(base);
    baseRef.current = base;
    // The subtree gets a real root rather than <body>: <body> must stay free of
    // containment because it is where every overlay portals to (see BASE_CSS).
    const el = w.document.createElement('div');
    el.className = 'popout-root';
    if (containerName) el.style.setProperty('container-name', containerName);
    w.document.body.appendChild(el);
    setRoot(el);
    setPopout(w);
    return true;
  };

  const closePopout = (): void => {
    const w = popoutRef.current;
    popoutRef.current = null;
    clonesRef.current.clear();
    baseRef.current = null;
    setRoot(null);
    setPopout(null);
    if (w && !w.closed) w.close();
  };

  // Never leave an orphan child: React cleanups don't run on unload, so pagehide
  // is needed too (theme-editor precedent).
  useEffect(() => {
    const closeOnUnload = () => { popoutRef.current?.close(); };
    window.addEventListener('pagehide', closeOnUnload);
    return () => {
      window.removeEventListener('pagehide', closeOnUnload);
      popoutRef.current?.close();
    };
  }, []);

  // Theme/token mirroring + user-closed detection.
  useEffect(() => {
    if (!popout) return;
    const src = document.documentElement;
    const sync = () => {
      if (popout.closed) return;
      const dst = popout.document.documentElement;
      for (const a of MIRROR_ATTRS) {
        const v = src.getAttribute(a);
        if (v === null) dst.removeAttribute(a); else dst.setAttribute(a, v);
      }
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(src, { attributes: true, attributeFilter: MIRROR_ATTRS });
    const onGone = () => {
      const w = popoutRef.current;
      popoutRef.current = null;
      clonesRef.current.clear();
      baseRef.current = null;
      setRoot(null);
      setPopout(null);
      // beforeunload also fires on a NAVIGATE (reload): the portal DOM dies with
      // the document and the named window would be reused blank next time.
      setTimeout(() => { try { if (w && !w.closed) w.close(); } catch { /* gone */ } }, 0);
    };
    popout.addEventListener('beforeunload', onGone);
    return () => { mo.disconnect(); popout.removeEventListener('beforeunload', onGone); };
  }, [popout]);

  // Late stylesheets. The clone in openPopout is a SNAPSHOT: a React.lazy chunk
  // (and in dev every HMR update) injects its CSS afterwards, and the child would
  // render that part unstyled. Observing the MAIN document's head — deliberately,
  // that is where the app injects — keeps the child in sync while it is open.
  // LIMIT: this tracks ADDED and REMOVED sheets, not a <style> whose textContent
  // is rewritten in place. style-loader does that on an HMR edit, so a dev-only
  // hot CSS change can go stale in an already-open child; reopening it re-clones.
  useEffect(() => {
    if (!popout) return;
    const clones = clonesRef.current;
    const mo = new MutationObserver((records) => {
      if (popout.closed) return;
      const head = popout.document.head;
      const base = baseRef.current;
      for (const rec of records) {
        for (const node of Array.from(rec.addedNodes)) {
          if (!isStylesheetNode(node) || clones.has(node)) continue;
          const clone = cloneSheet(node as Element);
          clones.set(node, clone);
          head.insertBefore(clone, base && base.parentNode === head ? base : null);
        }
        for (const node of Array.from(rec.removedNodes)) {
          const clone = clones.get(node);
          if (!clone) continue;
          clones.delete(node);
          clone.remove();
        }
      }
    });
    mo.observe(document.head, { childList: true });
    return () => mo.disconnect();
  }, [popout]);

  const portal = useCallback((children: React.ReactNode): React.ReactPortal | null => {
    if (!popout || popout.closed || !root) return null;
    // children in the props object, not as a rest arg: the provider declares
    // `children` as a required prop, which the varargs overload cannot satisfy.
    return createPortal(React.createElement(HostWindowProvider, { window: popout, children }), root);
  }, [popout, root]);

  return { popout, root, portal, openPopout, closePopout };
}
