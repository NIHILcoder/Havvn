/**
 * Themed confirm / alert — the Ember replacement for the browser's blocking
 * window.confirm() / window.alert(). Mount <ConfirmProvider> once near the app
 * root, then call const { confirm, alert } = useConfirm() anywhere:
 *
 *   if (await confirm({ message: 'Remove this download?', danger: true })) …
 *   await alert({ title: 'Add failed', message: err });
 *
 * Both return promises, so call sites become async but read the same as before.
 *
 * REALM — the dialog appears in the window that ASKED for it.
 * A room panel can be torn off into its own OS window (utils/popout.ts) while
 * this provider stays at the app root in the MAIN window. Without the routing
 * below, a confirm raised by a detached panel — "give these members a virtual
 * IP?", "delete this file?" — renders in the main window: the click happened on
 * one monitor and the question appears on another, or behind it. So the
 * REQUESTING REALM IS CAPTURED AT CALL TIME (`useConfirm` reads the host window
 * of the component that calls it) and the head of the queue is portalled into
 * that window's <body>, wrapped in HostWindowProvider so the dialog's Escape
 * listener, focus trap and activeElement reads all resolve to the window it is
 * actually in.
 *
 * MAIN-WINDOW BEHAVIOUR IS UNCHANGED BY CONSTRUCTION: `resolveDialogRealm`
 * renders IN PLACE — the exact tree, the exact DOM position, as before — for a
 * main-window provider answering a main-window request, and that is the only
 * case it ever does. There is no "portal to body" path in an undetached app.
 *
 * The provider also composes the other way round: mounted a second time inside a
 * detached window's shell it becomes the nearest provider for that subtree, so
 * that window gets its own queue. That case still portals (to its own window's
 * <body>), because a shell lives under `.popout-root` and rendering a fixed
 * backdrop in place there would trap it — see `resolveDialogRealm`.
 *
 * QUEUE — unchanged. A confirm()/alert() raised while another is open waits its
 * turn instead of clobbering the first's resolver. It is now drained on unmount
 * (confirms answer false, alerts resolve): with a per-window provider, closing a
 * window with a dialog queued would otherwise leave `await confirm()` pending
 * forever in the main JS realm — a silent deadlock inside a handler. In the main
 * window that provider never unmounts, so this changes nothing there either.
 *
 * ── A DIALOG CAN OUTLIVE THE WINDOW IT IS SHOWING IN ─────────────────────────
 * The dock's hoisted panels changed which provider answers them. A panel is now
 * mounted ONCE in the MAIN React tree and its DOM re-parented into whichever zone
 * claims it, so a panel showing on the second monitor is no longer INSIDE the dock
 * shell's own <ConfirmProvider> — the nearest provider is the app root's, in the
 * main window, and only the REQUESTING REALM says otherwise. Two consequences:
 *
 *  - the shell's provider now serves the shell's own UI only, and closing a dock
 *    window no longer unmounts a provider with the panel's question in it, so the
 *    unmount drain above does not cover this case;
 *  - the dialog is portalled into a window that can die while it is open, and
 *    `resolveDialogRealm`'s fallback to the provider's realm can only take effect
 *    on a RENDER. Nothing re-renders this provider when a child window closes —
 *    the death is observed by the dock's host, several subtrees away — so without
 *    the watch below the dialog stays portalled into a torn-down document: not
 *    visible anywhere, and the `await confirm()` behind it never settles.
 *
 * So the head request's realm is WATCHED (`dialogRealmWatch` + the effect that
 * consumes it), and the dialog re-homes to this provider's own window when that
 * realm dies. The question moves to the main window rather than being answered
 * `false` behind the user's back — a question they can still see and still answer.
 * Watching costs two listeners on ONE window, and only ever a window that is not
 * this provider's own, so the main-window path adds nothing at all.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';
import { Button } from './Button';
import { IconName } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { HostWindowProvider, REAL_HOST, useHostWindow, type HostWindow } from '../utils/hostWindow';

export interface ConfirmOptions {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  icon?: IconName;
}
export interface AlertOptions {
  title?: string;
  message: React.ReactNode;
  okLabel?: string;
  icon?: IconName;
}

interface ConfirmApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

/**
 * What the context actually carries: the same two calls plus the realm the
 * caller lives in. `useConfirm` supplies the realm so no call site has to know
 * it exists.
 */
interface ConfirmRequestApi {
  confirm: (opts: ConfirmOptions, host: HostWindow) => Promise<boolean>;
  alert: (opts: AlertOptions, host: HostWindow) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmRequestApi | null>(null);

export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  // Captured HERE, at the call site's position in the tree — not in the provider,
  // which by definition sits in whichever window mounted it. With no
  // HostWindowProvider above (the whole main-window tree) this is REAL_HOST, a
  // module constant, so the memo below is stable and the request is identical to
  // what it used to be.
  const host = useHostWindow();
  return useMemo<ConfirmApi>(() => ({
    confirm: (opts: ConfirmOptions) => ctx.confirm(opts, host),
    alert: (opts: AlertOptions) => ctx.alert(opts, host),
  }), [ctx, host]);
}

/** A realm we can actually portal into, or null: live window, live <body>. */
function usableRealm(h: HostWindow | null | undefined): HostWindow | null {
  if (!h) return null;
  const doc = h.document as Document | undefined;
  const win = h.window as (Window & { closed?: boolean }) | undefined;
  if (!doc || !win || win.closed || !doc.body) return null;
  return h;
}

/**
 * Where the head of the queue must render, or null for "in place" — i.e. exactly
 * where this provider already is.
 *
 * Pure and duck-typed so the whole decision table is testable with no DOM.
 *
 * "In place" is reserved for ONE situation: a provider in the real main window
 * answering a request from that same window. That is the case that must not
 * change, and pinning it to `provider === REAL_HOST` (the identity
 * `useHostWindow()` returns when no HostWindowProvider is above it) rather than
 * to document equality is deliberate — because a provider mounted INSIDE a
 * detached window's shell sits under `.popout-root`, which sets
 * `container-type` and is therefore a containing block for fixed descendants.
 * Rendering in place there would trap the Modal's fixed backdrop inside the
 * panel's box: a dialog scaled to a sliver of the window, which looks almost
 * right and is very hard to diagnose. So a provider anywhere other than the main
 * tree always portals out to a <body>, a sibling of `.popout-root`.
 *
 * A dead requesting realm (window closed, document torn down) falls back to the
 * PROVIDER's realm rather than to null, so the dialog stays visible and its
 * promise still settles; portalling into a closed window would show it to nobody.
 * With no DOM at all (Node tests) both are unusable and the answer is "in place".
 */
export function resolveDialogRealm(provider: HostWindow, request: HostWindow | null | undefined): HostWindow | null {
  const target = usableRealm(request) ?? usableRealm(provider);
  if (!target) return null;
  if (provider === REAL_HOST && target.document === provider.document) return null;
  return target;
}

/**
 * Pure: the foreign window whose death must re-home the open dialog, or null when
 * there is nothing to watch.
 *
 * Null in every case that is not "this dialog is currently drawn in a window this
 * provider does not own":
 *  - nothing queued, or the dialog renders in place  → no realm to lose;
 *  - the dialog is already in the provider's own window → losing it takes the
 *    provider with it, and the unmount drain is the mechanism for that;
 *  - no DOM at all (Node tests) → `resolveDialogRealm` answered "in place".
 * That is what keeps the undetached app free of any listener whatsoever.
 */
export function dialogRealmWatch(provider: HostWindow, request: HostWindow | null | undefined): Window | null {
  const realm = resolveDialogRealm(provider, request);
  if (!realm) return null;
  const win = realm.window as Window | undefined;
  if (!win || win === (provider.window as Window | undefined)) return null;
  return win;
}

/** The parts of a queued request that settling needs. */
type Settleable =
  | { kind: 'confirm'; resolve: (v: boolean) => void }
  | { kind: 'alert'; resolve: () => void };

/**
 * Empty the queue, settling every promise (confirms answer false — the safe
 * answer for a question nobody can see). Returns how many were settled.
 *
 * Splices FIRST, then settles, so a resolver that reacts by draining again (a
 * handler responding to its own cancellation) finds an empty queue instead of
 * settling the remaining requests a second time.
 */
export function drainRequests(queue: Settleable[]): number {
  const pending = queue.splice(0);
  for (const r of pending) {
    if (r.kind === 'confirm') r.resolve(false);
    else r.resolve();
  }
  return pending.length;
}

type Req =
  | ({ kind: 'confirm' } & ConfirmOptions & { host: HostWindow; resolve: (v: boolean) => void })
  | ({ kind: 'alert' } & AlertOptions & { host: HostWindow; resolve: () => void });

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  // The realm this provider itself renders in — the yardstick for "same window".
  const providerHost = useHostWindow();
  // A QUEUE, not a single slot: a confirm()/alert() raised while another is open
  // waits its turn instead of clobbering the first's resolver (which would leave
  // the first promise unsettled forever). The head is the visible dialog.
  const queue = useRef<Req[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const req = queue.current[0] || null;

  const confirm = useCallback((opts: ConfirmOptions, host: HostWindow) => new Promise<boolean>((resolve) => {
    queue.current.push({ kind: 'confirm', ...opts, host, resolve });
    bump();
  }), []);
  const alert = useCallback((opts: AlertOptions, host: HostWindow) => new Promise<void>((resolve) => {
    queue.current.push({ kind: 'alert', ...opts, host, resolve });
    bump();
  }), []);
  // Stable identity: consumers of useConfirm no longer re-render on every open
  // and close, which matters now that panels subscribing to it can be anywhere.
  const api = useMemo<ConfirmRequestApi>(() => ({ confirm, alert }), [confirm, alert]);

  // Never strand an awaiting caller when this provider goes away with the window
  // that mounted it. Empty deps: this runs on unmount only.
  useEffect(() => () => { drainRequests(queue.current); }, []);

  // Re-home an open dialog when the window it is drawn in dies (see the header).
  // Null for every main-window case, so this effect is inert in an undetached app.
  const watched = dialogRealmWatch(providerHost, req?.host);
  useEffect(() => {
    if (!watched) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `beforeunload`/`pagehide` fire BEFORE `closed` flips, so re-deciding
    // synchronously would pick the dying window all over again. One macrotask
    // later `usableRealm` sees `closed` and falls back to this provider's realm.
    // (Same reason usePopout defers its own force-close by a tick.)
    const onGone = () => { if (timer === undefined) timer = setTimeout(() => { timer = undefined; bump(); }, 0); };
    try {
      watched.addEventListener('pagehide', onGone);
      watched.addEventListener('beforeunload', onGone);
    } catch { /* window already torn down — the bump below covers it */ }
    // It may ALREADY be gone: the close can land between the render that computed
    // `watched` and this effect. Re-deciding once is safe and cannot loop — the
    // deps do not change, so a bump does not re-run this.
    if ((watched as Window & { closed?: boolean }).closed) onGone();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      try {
        watched.removeEventListener('pagehide', onGone);
        watched.removeEventListener('beforeunload', onGone);
      } catch { /* window gone */ }
    };
  }, [watched]);

  const close = (value: boolean) => {
    const head = queue.current.shift();
    if (!head) return;
    if (head.kind === 'confirm') head.resolve(value);
    else head.resolve();
    bump();
  };

  const dialog = req && (
    <Modal
      size="sm"
      icon={req.icon || (req.kind === 'confirm' && req.danger ? 'alert-triangle' : undefined)}
      title={req.title || (req.kind === 'confirm' ? t('common.confirm') : t('common.notice'))}
      onClose={() => close(false)}
      // A confirm is asked ABOUT whatever is already open, so it must never
      // land underneath it. Without this it does: Modal renders in place, and
      // this provider sits near the app root, so a dialog that portals to
      // <body> (e.g. a picker) comes later in the DOM and wins at equal
      // z-index — the confirm appears BEHIND the modal that requested it and
      // the user has to close that modal to reach it.
      //
      // The same reasoning is why the portalled branch below lands on <body>
      // rather than inside `.popout-root`: last in that document, above the
      // pickers and menus that portal there, and outside the `container-type`
      // box that would otherwise trap its fixed backdrop.
      backdropClassName="um-backdrop-top"
      bodyClassName="um-body-plain"
      footer={req.kind === 'confirm' ? (
        <>
          <Button variant="ghost" onClick={() => close(false)}>{req.cancelLabel || t('common.cancel')}</Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{req.confirmLabel || t('common.confirm')}</Button>
        </>
      ) : (
        <Button variant="primary" onClick={() => close(false)}>{req.okLabel || t('common.ok')}</Button>
      )}
    >
      <p>{req.message}</p>
    </Modal>
  );

  const realm = resolveDialogRealm(providerHost, req?.host);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {dialog && (realm
        // The portal keeps the dialog in THIS React tree (so i18n, the modal
        // stack and `close()` all still work) while its DOM lives in the asking
        // window. HostWindowProvider is what makes Modal's Escape listener and
        // focus trap follow it there; without it the dialog would be visible in
        // the child window but keyed to the main one.
        ? createPortal(
          <HostWindowProvider window={realm.window}>{dialog}</HostWindowProvider>,
          realm.document.body,
        )
        : dialog)}
    </ConfirmContext.Provider>
  );
};
