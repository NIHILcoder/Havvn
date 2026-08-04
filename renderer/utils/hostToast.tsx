/**
 * hostToast — which OS window does a toast land in?
 *
 * `toast()` from react-hot-toast is a MODULE SINGLETON: it dispatches into a
 * store and has no idea which React subtree called it. With every room panel
 * detachable into its own OS window (dock P3), a toast raised by a panel on the
 * second monitor would still be drawn by the one <Toaster> in the main window —
 * feedback for an action the user performed somewhere they are not looking. Same
 * complaint as the confirm dialog's (see components/ConfirmDialog.tsx), and this
 * is its other half.
 *
 * react-hot-toast 2.6 already routes per TOASTER ID — a dispatch picks its store
 * with `toast.toasterId || <default>` and `<Toaster toasterId>` subscribes to
 * exactly that one store — so the fix is a routing rule, not a second library:
 *
 *   main window    <HostToaster />           + `toast()` with no id  → 'default'
 *   dock window W  <HostToastRealm toasterId={W}> around the subtree, and every
 *                  toast raised inside it carries `toasterId: W`.
 *
 * ADOPTION — one line per detachable component:
 *
 *     const toast = useHostToast();   // deliberately SHADOWS the module import
 *
 * so none of the existing `toast.error(…)` call sites change. `useHostToast()`
 * returns the SAME type as react-hot-toast's default export, so shadowing is
 * type-safe for every member, not just the two we happen to use today.
 * Components that can never be detached keep the bare import — that is
 * main-window UI and routing it would be noise.
 *
 * ONE CAVEAT, and it bites in exactly one shape. A bound api is a VALUE captured
 * by whatever closure reads it, so an effect that must NOT re-run when the panel
 * changes windows (a live capture, a peer connection, a subscription) has to read
 * it through a ref — `const toastRef = useRef(toast); toastRef.current = toast;` —
 * rather than list it in the dependency array. Putting it in the deps would tear
 * the effect down and rebuild it on a dock move; leaving it out without the ref
 * would keep toasting into the window the panel used to be in. ScreenView and the
 * voice settings mic test are the two cases in the tree today.
 *
 * WHO MOUNTS THE PROVIDER, after the dock's mount hoist. <HostToastRealm> below
 * wraps a dock window's SHELL, which is what mounts that window's <Toaster>. It no
 * longer wraps the panels: they are mounted once from a fixed position in the MAIN
 * React tree and re-parented into whichever zone slot claims them, so the nearest
 * provider in the React tree is the main one. The mount host therefore wraps every
 * panel in its own <ToastRealmProvider toasterId={…}> — UNCONDITIONALLY, with
 * `undefined` for a docked zone, so the wrapper's element type never changes and a
 * docked↔window move cannot remount the panel. `undefined` reads as "no realm"
 * exactly like no provider at all, which is what keeps the docked case unchanged.
 *
 * MAIN WINDOW IS UNCHANGED BY CONSTRUCTION. With no realm provider above it the
 * context value is `undefined`, `bindToastRealm` returns the module singleton
 * ITSELF (not a wrapper), and `withToasterId` returns the caller's options
 * object unmodified. There is no code path where an undetached app behaves
 * differently — that is why the "no id" case short-circuits instead of stamping
 * `toasterId: 'default'`.
 *
 * WHERE THE CHILD'S TOASTER MOUNTS. <Toaster> renders a `position: fixed`
 * container, and `.popout-root` sets `container-type`, which makes it a
 * containing block for fixed descendants. So a detached window's Toaster is
 * portalled to THAT window's <body> — a sibling of `.popout-root`, never a
 * descendant — exactly like every other floating surface in a torn-off panel
 * (utils/popout.ts BASE_CSS spells the rule out).
 *
 * STYLING IN A CHILD WINDOW depends on utils/popout.ts's <head> observer
 * mirroring goober's in-place <style> rewrites; without that a toast raised in a
 * window opened before the first toast ever rendered comes out unstyled. See the
 * observer's comment there.
 *
 * DOM-LESS SAFETY: nothing here dereferences a global at module load, and
 * <HostToaster> renders IN PLACE when it has no portal target, so
 * renderToStaticMarkup tests (no jsdom) never reach createPortal.
 */
import React, { createContext, useContext, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Toaster,
  toast as globalToast,
  type DefaultToastOptions,
  type ToastOptions,
  type ToastPosition,
} from 'react-hot-toast';
import { usePortalTarget } from './hostWindow';

/** The exact shape of react-hot-toast's default export — what a realm binds to. */
export type ToastApi = typeof globalToast;

/**
 * Toast look and placement, in one place so a detached window's Toaster is
 * indistinguishable from the main one. Values lifted verbatim from App.tsx.
 */
export const TOAST_POSITION: ToastPosition = 'bottom-right';
export const TOAST_OPTIONS: DefaultToastOptions = {
  duration: 4000,
  style: {
    // Cap the toast so a long path or stack never blows past the window edge —
    // the previous unbounded width is exactly what made ENOTEMPTY paths unreadable.
    maxWidth: 'min(360px, calc(100vw - 32px))',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.4',
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
  },
  error: {
    // Errors carry more text and are the ones people actually need to read.
    duration: 7000,
  },
};

/**
 * Pure: stamp a realm onto one call's options.
 *
 * Returns the caller's own object (identity, not a copy) when there is nothing
 * to stamp — that is what makes the main window's behaviour bit-for-bit the old
 * behaviour. An explicit `toasterId` from the caller always wins: aiming a toast
 * at another window is a deliberate act and the ambient realm must not override
 * it.
 */
export function withToasterId<T extends ToastOptions>(
  opts: T | undefined,
  toasterId: string | undefined,
): T | undefined {
  if (!toasterId) return opts;
  if (opts && opts.toasterId) return opts;
  return { ...(opts ?? ({} as T)), toasterId };
}

/**
 * Bind the toast API to a realm. `undefined` returns the singleton UNWRAPPED, so
 * an undetached app has no extra indirection at all.
 *
 * `impl` exists for tests: the routing rule is the interesting part and it is
 * provable against a spy, with no DOM and no real store.
 */
export function bindToastRealm(toasterId?: string, impl: ToastApi = globalToast): ToastApi {
  if (!toasterId) return impl;
  const stamp = <T extends ToastOptions>(o: T | undefined): T | undefined => withToasterId(o, toasterId);
  const api = ((message, opts) => impl(message, stamp(opts))) as ToastApi;
  api.error = (message, opts) => impl.error(message, stamp(opts));
  api.success = (message, opts) => impl.success(message, stamp(opts));
  api.loading = (message, opts) => impl.loading(message, stamp(opts));
  api.custom = (message, opts) => impl.custom(message, stamp(opts));
  // dismiss/remove take the realm as their SECOND argument rather than in an
  // options bag; default it, but let an explicit one through for the same reason
  // withToasterId yields to an explicit id.
  api.dismiss = (toastId, id) => impl.dismiss(toastId, id ?? toasterId);
  api.dismissAll = (id) => impl.dismissAll(id ?? toasterId);
  api.remove = (toastId, id) => impl.remove(toastId, id ?? toasterId);
  api.removeAll = (id) => impl.removeAll(id ?? toasterId);
  api.promise = (promise, msgs, opts) => impl.promise(promise, msgs, stamp(opts));
  return api;
}

/**
 * The ambient realm. Deliberately NO provider in the main tree (hostWindow's
 * discipline): "no provider" is the normal case and it must mean "the default
 * toaster", by default rather than by configuration.
 */
const ToastRealmContext = createContext<string | undefined>(undefined);

export const ToastRealmProvider: React.FC<{ toasterId?: string; children: React.ReactNode }> = ({ toasterId, children }) => (
  <ToastRealmContext.Provider value={toasterId}>{children}</ToastRealmContext.Provider>
);

/** The toaster id this subtree's toasts are routed to (undefined = main window). */
export function useToastRealm(): string | undefined {
  return useContext(ToastRealmContext);
}

/**
 * The toast API for THIS subtree's window. Adopt as
 * `const toast = useHostToast();` — see the shadowing note above.
 */
export function useHostToast(): ToastApi {
  const toasterId = useContext(ToastRealmContext);
  return useMemo(() => bindToastRealm(toasterId), [toasterId]);
}

export interface HostToasterProps {
  /** Omit for the app-wide default toaster (the main window). */
  toasterId?: string;
  /**
   * Where to portal the fixed container. Omit to render IN PLACE, which is what
   * the main window does and has always done.
   */
  target?: HTMLElement | null;
}

/** One window's toast surface, styled identically everywhere. */
export const HostToaster: React.FC<HostToasterProps> = ({ toasterId, target }) => {
  const node = <Toaster position={TOAST_POSITION} toasterId={toasterId} toastOptions={TOAST_OPTIONS} />;
  return target ? createPortal(node, target) : node;
};

export interface HostToastRealmProps {
  /** The dock window's frame name — its store id and its <Toaster>'s id. */
  toasterId: string;
  /** Override the portal target; defaults to this subtree's own <body>. */
  target?: HTMLElement | null;
  children?: React.ReactNode;
}

/**
 * Provider + that window's own Toaster in ONE wrap, so a detached shell cannot
 * mount the routing without the surface it routes to (the same reason
 * usePopout's `portal()` mounts HostWindowProvider itself). The target defaults
 * to the host window's <body> — a sibling of `.popout-root`, never inside it.
 */
export const HostToastRealm: React.FC<HostToastRealmProps> = ({ toasterId, target, children }) => {
  const hostBody = usePortalTarget();
  return (
    <ToastRealmProvider toasterId={toasterId}>
      {children}
      <HostToaster toasterId={toasterId} target={target ?? hostBody ?? null} />
    </ToastRealmProvider>
  );
};
