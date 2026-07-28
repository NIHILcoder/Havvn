/**
 * hostWindow — which OS window does this subtree's DOM actually live in?
 *
 * A room panel can be torn off into a child window (utils/popout.ts). React keeps
 * running in the MAIN renderer's JS realm — state, refs, IPC subscriptions and
 * timers are untouched — but the DOM moves. Every bare `document` / `window` in a
 * component then talks to the wrong window: portals land in the main body,
 * click-away listeners never fire, viewport clamps measure the wrong box, and
 * fullscreen state is read from a document that never entered fullscreen.
 *
 * This module hands a subtree its OWN document/window instead.
 *
 * SCOPE — DOM ONLY.
 * The host window covers `document`, and `window` used as a VIEWPORT
 * (innerWidth/innerHeight), an EVENT TARGET, or the source of `navigator`,
 * `matchMedia`, `getComputedStyle`, `requestAnimationFrame`.
 * It must NEVER be used for:
 *   - `window.api` — the preload bridge. A child opened with
 *     window.open('about:blank') has no preload and no `api` object; the bridge is
 *     always the main realm's, no matter where the DOM sits.
 *   - `localStorage` — per-origin, already shared by every window.
 *   - the VOICE_PREFS_EVENT dispatch/listen pair — both ends are deliberately
 *     main-realm and only work because they agree. Making either side host-relative
 *     would silently unpair them.
 *
 * PRECEDENCE — an ELEMENT beats the context, always.
 * `el.ownerDocument` is authoritative: a subtree can be portalled into a window
 * that its React-tree provider knows nothing about (the chat's react-palette
 * already does exactly that). So:
 *   - a ref in hand  →  `resolveHostWindow(ref.current, useHostWindow())`, or just
 *     `el.ownerDocument` / `el.ownerDocument.defaultView ?? window` where that
 *     pattern is already established (ProfileCard, RoomChat);
 *   - no element yet (a portal container, a listener registered before mount)
 *     →  `useHostWindow()`.
 * Never reroute an existing ownerDocument call through the context — that is a
 * regression, not a cleanup. Fullscreen and picture-in-picture are the sharpest
 * cases: `requestFullscreen()` sets `fullscreenElement` on the ELEMENT's document,
 * so reading it from anywhere else reproduces the stuck state.
 *
 * DEFAULT — no provider means the real globals.
 * There is deliberately NO provider in the main tree. `useHostWindow()` falls back
 * to the actual `document`/`window`, so a component rendered anywhere outside a
 * pop-out behaves identically to before by construction rather than by inspection.
 *
 * DOM-LESS SAFETY — the globals are read through getters off `globalThis`, never
 * dereferenced at module load and never as bare identifiers. Renderer tests are
 * `renderToStaticMarkup` with no jsdom, where `document` and `window` do not exist;
 * a `{ document, window }` object literal here would throw ReferenceError at import
 * time in every module that imports this one, and a bare-identifier getter would
 * throw on any later read.
 *
 * TWO PROVIDERS, AND WHY — <HostWindowProvider> vs <HostWindowRealm>.
 * `HostWindowProvider` takes a window that EXISTS: it is mounted by usePopout's
 * `portal()`, which only runs once there is a child window, so "no window" is
 * expressible only as "no provider". That is exactly right for a subtree that
 * lives inside the child.
 *
 * The dock's hoisted panels are the other shape. A panel is mounted ONCE, from a
 * fixed position in the MAIN React tree, and its DOM container is re-parented into
 * whichever zone slot currently claims it — including a slot inside a torn-off
 * window. Its host window therefore CHANGES over the panel's lifetime, and "docked"
 * (the real globals) is one of the values it changes to. Wrapping conditionally —
 * `w ? <HostWindowProvider window={w}>{p}</HostWindowProvider> : p` — would put a
 * DIFFERENT ELEMENT TYPE at the same child position, and React unmounts and
 * remounts a child whose type changes. That is precisely the remount the hoist
 * exists to prevent, and it would fire on the one move that matters most (docked ↔
 * window). So the realm wrapper must be UNCONDITIONAL and must accept `null`:
 * `<HostWindowRealm window={realmOrNull}>{panel}</HostWindowRealm>`, always, with
 * null meaning REAL_HOST — value-identical to no provider at all.
 */
import React, { createContext, useContext, useMemo } from 'react';

export interface HostWindow {
  readonly document: Document;
  readonly window: Window;
}

// Property lookup on globalThis yields `undefined` for a missing global instead of
// throwing (unlike a bare identifier), which is what keeps this safe in Node.
const globals = globalThis as unknown as { document?: Document; window?: Window };

/** The real renderer window — the value `useHostWindow()` falls back to. */
export const REAL_HOST: HostWindow = {
  get document(): Document { return globals.document as Document; },
  get window(): Window { return globals.window as Window; },
};

const HostWindowContext = createContext<HostWindow | null>(null);

/**
 * The host window for this subtree. NEVER throws when there is no provider
 * (unlike useTranslation) — "no provider" is the normal main-window case.
 */
export function useHostWindow(): HostWindow {
  return useContext(HostWindowContext) ?? REAL_HOST;
}

/**
 * Pure: an element's own host wins; anything missing falls back to the context.
 * `defaultView` is null for a document whose window has been closed, which is
 * exactly when the context fallback is wanted.
 */
export function resolveHostWindow(el: Element | null | undefined, ctx: HostWindow): HostWindow {
  const doc = el?.ownerDocument ?? null;
  const win = doc?.defaultView ?? null;
  return doc && win ? { document: doc, window: win } : ctx;
}

/**
 * Pure: the <body> to portal into — the anchor's own, else the context's.
 * Typed non-nullable because every caller feeds it straight to `createPortal`,
 * and react-dom/server throws on createPortal anyway, so no DOM-less test path can
 * reach one. (In Node it is `undefined`; nothing dereferences it there.)
 */
export function portalTargetFor(el: Element | null | undefined, ctx: HostWindow): HTMLElement {
  return resolveHostWindow(el, ctx).document?.body as HTMLElement;
}

/**
 * The body to portal into, in one call — for the common case of a component with
 * no element of its own yet:
 *   `createPortal(menu, usePortalTarget())`         — this subtree's host window
 *   `createPortal(card, usePortalTarget(anchor))`   — the anchor's own window
 * With a ref in hand, prefer `portalTargetFor(ref.current, useHostWindow())` at the
 * point of use: the element is authoritative, and a ref is null on first render.
 */
export function usePortalTarget(anchor?: Element | null): HTMLElement {
  return portalTargetFor(anchor, useHostWindow());
}

/**
 * Wraps a torn-off subtree so everything under it resolves to the child window.
 * Mounted by usePopout's `portal()` helper rather than by hand at call sites, so
 * detaching a panel cannot silently forget the provider.
 */
export const HostWindowProvider: React.FC<{ window: Window; children: React.ReactNode }> = ({ window: w, children }) => {
  const value = useMemo<HostWindow>(() => ({ document: w.document, window: w }), [w]);
  return <HostWindowContext.Provider value={value}>{children}</HostWindowContext.Provider>;
};

/**
 * Provide a host that can CHANGE — including back to the real globals — without
 * ever changing the subtree's SHAPE. See the "TWO PROVIDERS" note in the header:
 * this is the wrapper for a subtree that is mounted once and re-parented between
 * windows, where a conditional <HostWindowProvider> would remount the child on the
 * very move it is there to survive.
 *
 * `null` provides REAL_HOST, which is the SAME VALUE `useHostWindow()` falls back
 * to with no provider at all — so a panel that never leaves the main window behaves
 * identically to one rendered outside this wrapper, by construction rather than by
 * inspection. REAL_HOST's lazy getters keep that case DOM-less-safe too: nothing is
 * dereferenced here, so a `renderToStaticMarkup` test can render the wrapper.
 *
 * A closed window is deliberately NOT special-cased: `resolveHostWindow` already
 * falls back through a null `defaultView`, and a host whose window has just died is
 * a transient the owner resolves by handing down a new realm.
 */
export const HostWindowRealm: React.FC<{ window: Window | null; children: React.ReactNode }> = ({ window: w, children }) => {
  const value = useMemo<HostWindow>(() => (w ? { document: w.document, window: w } : REAL_HOST), [w]);
  return <HostWindowContext.Provider value={value}>{children}</HostWindowContext.Provider>;
};
