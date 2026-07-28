/**
 * DockWindowHost — the OS window that hosts ONE torn-off dock GROUP.
 *
 * A window zone is not "a panel in a window": it is a whole zone — tab strip and
 * all — living on another monitor. That is the entire point of tear-off ("Voice
 * and Chat together on the second monitor"): drag Chat into Voice's strip, tear
 * that strip off, and both arrive as a group you can still switch between. A host
 * that could only ever show one panel would degrade that into two OS windows the
 * user arranges by hand.
 *
 * So this component owns the WINDOW and the CHROME, and takes the group itself as
 * `children`:
 *
 *   <DockWindowHost frameName="havvn-dock-1" title={…} dockBackLabel={…} onDockBack={…}>
 *     <DockZone zoneId="w1" panels={…} activeId={…} onSelect={…} … />
 *   </DockWindowHost>
 *
 * Composition rather than a `zone` prop on purpose: the zone's prop surface is
 * still moving (slots, drag wiring, the move menu) and none of it is this file's
 * business. What IS this file's business is everything a child window needs and a
 * docked zone does not:
 *
 *  1. OPENING AND OWNING the window (utils/popout.ts), including its `.popout-root`
 *     and the live stylesheet/theme mirroring that comes with it. `portal()` mounts
 *     HostWindowProvider for the subtree, so every panel inside resolves `document`
 *     to THIS window — its portals, click-away listeners and viewport clamps land
 *     where the user is looking.
 *  2. THE HEADER: the window title and the explicit DOCK-BACK control. There is no
 *     cross-window tab drag and there never will be — HTML5 drag-and-drop and
 *     pointer capture do not cross Electron BrowserWindow boundaries — so a real
 *     button is the whole way home, alongside the per-tab "Move to ▸" menu.
 *  3. THE WINDOW BEING CLOSED, by any route: the user's ✕, close-to-tray (main.ts
 *     closes every child on the owner's `hide`), owner close, quit. All of them
 *     surface identically as `onDockBack('closed')`, and the owner returns the
 *     group to the zone it was torn from. Uniformity is the safety property: every
 *     close path re-establishes "the room is never empty" with no special case.
 *  4. THE PER-WINDOW REALM SURFACES (invariant F). A confirm, a toast or a live-
 *     region announcement raised by a detached panel must land in ITS window, not
 *     in the one the user is not looking at. All three hosts are mounted HERE, by
 *     the shell, rather than at the call site — the same discipline as `portal()`
 *     mounting HostWindowProvider: detaching a group cannot silently forget them.
 *
 * ── P4: the panels are no longer in this subtree ─────────────────────────────
 * Panel BODIES are mounted once, high in the main tree, and portalled into their
 * zone's slot (DockPanelMounts.tsx) so a move cannot remount them. `children` is
 * now the zone's CHROME — its tab strip and its slots — not the panels themselves.
 * Two consequences, both handled rather than discovered:
 *  • The realm no longer reaches a panel through `portal()`'s HostWindowProvider
 *    (React context follows the REACT parent). This host therefore publishes its
 *    window upward via `onRealm`, and the mount host wraps each panel in it.
 *  • Neither does this shell's ConfirmProvider. A confirm raised by a detached
 *    panel now sits in the MAIN provider's queue and is portalled into this window,
 *    because `useConfirm()` captures the requesting realm at CALL time — so the
 *    dialog still appears where the user is. The behavioural difference is at the
 *    end of life: if this window dies with a dialog queued, the main provider falls
 *    back to its own realm and the question reappears in the room window instead of
 *    being drained to false. That is arguably an improvement, and it is stated here
 *    rather than left to be found. The shell's own ConfirmProvider now serves only
 *    the shell's UI.
 *
 * ── What this file deliberately does NOT do ──────────────────────────────────
 * It holds no model state. It never decides WHERE a group docks back to; it
 * reports that the window is gone and the dock owner applies the pinned rule
 * (back to `origin`). It does not close its own window on dock-back either: it
 * reports, the owner unmounts it, and usePopout's unmount cleanup closes the OS
 * window. One direction of control, so a refused dock-back cannot leave a window
 * open with nothing rendering into it.
 *
 * It also never calls `t()`. Every user-visible string arrives already
 * translated, exactly like DockZone's labels and DockTabStrip's `ariaLabel` —
 * which is what keeps this whole folder free of the i18n context and testable
 * from a harness that has none. The caller supplies `title`
 * (`rooms.dock.windowTitle` + the group's panels) and `dockBackLabel`
 * (`rooms.dock.dockBack`), and takes `frameName` from
 * `dockWindowFrameName(zoneId)` so the model's opaque `w1` and Electron's
 * `havvn-dock-1` cannot drift apart.
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Icon } from '../../../components/Icon';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import { HostToastRealm, bindToastRealm } from '../../../utils/hostToast';
import { LiveAnnouncer } from '../../../utils/liveAnnouncer';
import { usePopout } from '../../../utils/popout';
import './DockWindowHost.css';

/**
 * Why the group is coming home. The owner needs the distinction: a `button` is a
 * deliberate re-dock, `closed` may be close-to-tray taking every child with it,
 * and `openFailed` means there is no window at all and the panels are currently
 * rendering NOWHERE — that one has to be handled in the same tick.
 */
export type DockBackReason = 'button' | 'closed' | 'openFailed';

export interface DockWindowLiveness {
  /** Has an open window been observed since the last close? */
  seen: boolean;
  /** Emit `onDockBack('closed')` for this step. */
  closed: boolean;
}

/**
 * Pure: the whole close-detection rule, extracted so the two ways it can be wrong
 * are pinned by a test rather than by hope. (Renderer tests are
 * renderToStaticMarkup with no jsdom — a window lifecycle cannot be exercised.)
 *
 *  - It must NOT report a close before the window ever opened. The host opens a
 *    macrotask after mount (see below), so there is always at least one pass where
 *    the window is legitimately absent; treating that as "closed" would dock the
 *    group back instantly and make tear-off look broken.
 *  - It must not report it TWICE. `closed` clears `seen`, so a second pass over an
 *    already-gone window is inert — which also means a StrictMode double-invoke,
 *    or a re-render triggered by the very dock-back this caused, cannot re-fire it.
 */
export function stepDockWindowLiveness(seen: boolean, present: boolean): DockWindowLiveness {
  if (present) return { seen: true, closed: false };
  return { seen: false, closed: seen };
}

export interface DockWindowShellProps {
  /**
   * The pool frame name (`havvn-dock-1`…). Identity of the OS window, the
   * `toasterId` of this window's toast host, and a `data-` hook for tests.
   */
  frameName: string;
  /** Window/header title, ALREADY TRANSLATED (this folder never calls `t()`). */
  title: string;
  /** Optional second line — the room name. Already translated. */
  subtitle?: string;
  /** Accessible name + tooltip for the dock-back control. Already translated. */
  dockBackLabel: string;
  /** The group: a `<DockZone>` with its own tab strip. */
  children: React.ReactNode;
  onDockBack: () => void;
  /**
   * Override where the toast host portals. Defaults (via HostToastRealm) to THIS
   * realm's `document.body` — a SIBLING of `.popout-root`, never a descendant:
   * the toast container is `position: fixed` and `.popout-root` carries
   * `container-type`, which makes it a containing block for fixed descendants
   * (popout.ts's BASE_CSS spells the rule out). With no DOM at all there is no
   * target and the host renders in place, which is what makes this component
   * reachable from the node test harness.
   */
  toastTarget?: HTMLElement | null;
}

/**
 * The subtree that lives inside `.popout-root`: realm surfaces, header, group.
 *
 * Exported separately from the host because it is the half that can be rendered
 * without a window — the host itself is nothing but a portal until one exists.
 */
export const DockWindowShell: React.FC<DockWindowShellProps> = ({
  frameName,
  title,
  subtitle,
  dockBackLabel,
  children,
  onDockBack,
  toastTarget,
}) => {
  // Pool slots are RECYCLED: dock back, tear off again, and `havvn-dock-1`
  // returns. react-hot-toast keeps a store per `toasterId` that OUTLIVES its
  // <Toaster>, so a toast still on screen when this window died would pop up in
  // the next window to take the slot — feedback about something the user
  // finished with minutes ago, in a window that has nothing to do with it.
  // Emptying this realm's store on unmount keeps the slot clean.
  useEffect(() => () => {
    try { bindToastRealm(frameName).removeAll(); } catch { /* store already gone */ }
  }, [frameName]);

  return (
    // INVARIANT F, both halves, mounted by the SHELL rather than by whoever tears
    // a group off — the same discipline as popout's `portal()` mounting
    // HostWindowProvider: detaching cannot silently forget them.
    //
    //  - HostToastRealm: routes every `useHostToast()` call inside this subtree to
    //    this window's toaster AND mounts that toaster (portalled to the window's
    //    <body>, outside `.popout-root`'s containment). Provider and surface in
    //    one wrap, so the routing can never point at a toaster that is not there.
    //  - ConfirmProvider: `useConfirm()` is a context read, so the NEAREST
    //    provider wins and a panel detached into this window asks its question
    //    HERE, with its own queue, and no call site changes.
    <HostToastRealm toasterId={frameName} target={toastTarget}>
      <ConfirmProvider>
        <div className="dock-window" data-dock-window={frameName}>
          <header className="dock-window-head">
            <span className="dock-window-title">
              <span className="dock-window-title-text" title={title}>{title}</span>
              {subtitle ? <span className="dock-window-sub" title={subtitle}>{subtitle}</span> : null}
            </span>
            <span className="dock-window-acts">
              {/* The ONLY way home. Cross-window tab drag is impossible — HTML5
                  DnD and pointer capture do not cross BrowserWindow boundaries —
                  so this is not a convenience, it is the mechanism. A real
                  <button>, reachable by Tab and announced by name inside THIS
                  window (where the panel's own "Move to ▸" menu is the other
                  keyboard path home). */}
              <button
                type="button"
                className="dock-window-btn"
                onClick={onDockBack}
                title={dockBackLabel}
                aria-label={dockBackLabel}
              >
                <Icon name="minimize" size={13} />
              </button>
            </span>
          </header>
          <div className="dock-window-body">{children}</div>
          {/* The third realm surface. A screen reader only voices the live regions
              of the window its virtual cursor is in, so "Chat moved to Left column"
              raised by a panel on this monitor has to be spoken HERE — a region in
              the main tree would say it to nobody. Mounted by the shell for the
              same reason as the other two: detaching a group cannot silently forget
              it. Costs two empty divs until something is said. */}
          <LiveAnnouncer />
        </div>
      </ConfirmProvider>
    </HostToastRealm>
  );
};

export interface DockWindowHostProps extends Omit<DockWindowShellProps, 'onDockBack' | 'toastTarget'> {
  /**
   * Optional `container-name` for `.popout-root`, so `@container <name> (…)` rules
   * written for the docked panel keep matching once it is torn off. The zone
   * establishes its own `dock` container either way; this is for panel rules that
   * name something else.
   */
  containerName?: string;
  /**
   * The window is gone (or never opened). Fires AT MOST ONCE per cause. The owner
   * docks the group back per the pinned rule and unmounts this host, whose
   * cleanup closes the OS window.
   */
  onDockBack: (reason: DockBackReason) => void;
  /**
   * This host's OS window as it opens and closes; `null` on close and on unmount.
   *
   * P4: panel BODIES are no longer children of this host — they are mounted once,
   * high in the main tree, and portalled into their zone's slot (DockPanelMounts).
   * A hoisted panel therefore cannot inherit the realm from `portal()`'s
   * HostWindowProvider, because context follows the REACT parent and its React
   * parent is the main tree. The owner hands it this window instead.
   *
   * Fired from a LAYOUT effect so the realm lands in the same commit the slot
   * adopts the container — before paint, never a frame late.
   */
  onRealm?: (win: Window | null) => void;
}

export const DockWindowHost: React.FC<DockWindowHostProps> = ({
  frameName,
  title,
  subtitle,
  dockBackLabel,
  containerName,
  onDockBack,
  onRealm,
  children,
}) => {
  const { popout, portal, openPopout } = usePopout(frameName, title, containerName);

  // Both callbacks live in refs so the lifecycle effects below can have EMPTY /
  // minimal dependency lists. The room re-renders on every gossip push (~700ms
  // throttle at best), and an effect that re-ran on each of those would either
  // reopen the window or re-arm the close detection dozens of times a minute.
  const goneRef = useRef(onDockBack);
  const openRef = useRef(openPopout);
  const realmRef = useRef(onRealm);
  useEffect(() => { goneRef.current = onDockBack; openRef.current = openPopout; realmRef.current = onRealm; });

  const seenRef = useRef(false);

  // OPEN — deferred by one macrotask, which is not a nicety.
  //
  // StrictMode (renderer/index.tsx) mounts, tears down and remounts every effect
  // in dev. Opening synchronously would open a window, have usePopout's unmount
  // cleanup close it, and then reopen — while the first window's `beforeunload`
  // is still in flight, which is exactly the input that makes close detection lie.
  // A timeout that the simulated unmount CANCELS means the double-invoke costs
  // nothing at all: one schedule, one cancel, one open. The user-visible cost is a
  // macrotask on a gesture that opens an OS window.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      // Denied by main.ts's allowlist, refused by the OS, or the pool slot is
      // still dying. The panels are rendering nowhere at this instant, so the
      // owner has to dock them back NOW — a refusal, never a silent no-op.
      if (!openRef.current()) goneRef.current('openFailed');
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
      // A real unmount is the owner taking the group back: forget the window so a
      // pending liveness pass cannot report a close that already happened by
      // agreement (and so a StrictMode remount starts clean).
      seenRef.current = false;
    };
  }, []);

  // CLOSED — usePopout nulls `popout` from the child's `beforeunload`, which is
  // the one signal that covers every route: the user's ✕, close-to-tray (main.ts
  // closes children on the owner's `hide`), owner close, quit, and a navigate.
  useEffect(() => {
    const step = stepDockWindowLiveness(seenRef.current, !!popout && !popout.closed);
    seenRef.current = step.seen;
    if (step.closed) goneRef.current('closed');
  }, [popout]);

  // THE REALM, published upward for the hoisted mounts (see `onRealm`).
  // A LAYOUT effect, so the owner's `setState` and the resulting re-render land in
  // the same commit cycle the slot adopts the container: a passive effect would
  // paint one frame with the panel's DOM inside this window but its React context
  // still pointing at the main one, i.e. portals and click-away listeners aimed at
  // the wrong document for a frame.
  useLayoutEffect(() => {
    realmRef.current?.(popout && !popout.closed ? popout : null);
  }, [popout]);
  // Unmount is the owner taking the group back; the realm is gone with the window.
  // Separate from the effect above so a reopen does not emit a spurious null first.
  useEffect(() => () => { realmRef.current?.(null); }, []);

  // Keep the OS title bar honest: the group's title changes whenever a panel is
  // dragged in or out, and usePopout only sets it at open time.
  useEffect(() => {
    if (!popout || popout.closed) return;
    try { popout.document.title = title; } catch { /* window gone mid-update */ }
  }, [popout, title]);

  // `portal()` returns null until the window exists — this component renders
  // NOTHING in the main window, which is what keeps a torn-off group from being
  // visible in two places at once. It also wraps the subtree in
  // HostWindowProvider, so the shell's realm surfaces (and every panel below
  // them) resolve `document` to THIS window.
  return portal(
    <DockWindowShell
      frameName={frameName}
      title={title}
      subtitle={subtitle}
      dockBackLabel={dockBackLabel}
      onDockBack={() => goneRef.current('button')}
    >
      {children}
    </DockWindowShell>,
  );
};

export default DockWindowHost;
