/**
 * DockPanelMounts — THE single mount point for every live dock panel.
 *
 * Render it ONCE, from a tree position that no dock change can disturb (RoomDetail
 * renders it as the last, unconditional child of `.room-detail-inner`). It renders
 * no DOM of its own — only portals — so where it sits costs nothing visually while
 * deciding everything about lifetime:
 *
 *   • INSIDE `.room-detail-inner`, because the room's OS-file drag/drop handlers
 *     receive panel events by React bubbling (the Files panel's drop reaches the
 *     room's `handleDrop` that way, and `onDragStartCapture` sets `internalDrag`).
 *     Moving the mount outside the room would silently kill both.
 *   • NOT inside the grid, RoomStage, or any branch that depends on `dock`: its
 *     tree position must be independent of the layout, or a move could unmount it —
 *     which is the entire bug this file exists to remove.
 *
 * Each panel is portalled into ITS OWN stable container (dockMountRegistry.ts), not
 * into the zone slot. React recreates a portal fiber when its container changes, so
 * portalling straight into the slot would remount on every move and buy nothing.
 * The container never changes; the SLOT adopts it with one `appendChild`.
 *
 * ── The realm travels with the SLOT, not with the mount ──────────────────────
 * A hoisted panel reads context from its REACT parent (this component, in the main
 * tree), not from its DOM parent. So `portal()`'s HostWindowProvider inside
 * DockWindowHost no longer reaches a panel that has been torn off, and the panel
 * would resolve `document` to the main window while its DOM lives in another one.
 * The owner therefore hands us each zone's realm and we wrap every panel here.
 *
 * Both wrappers are UNCONDITIONAL, and that is load-bearing: `<Provider>{x}</Provider>`
 * and `{x}` are different element types at the same child position, and React
 * remounts on a type change. Conditionally wrapping would reintroduce the exact
 * remount this design removes, on precisely the cross-realm move that matters most.
 * With no realm we provide the REAL window, which is value-identical to having no
 * provider at all (`useHostWindow()`'s own fallback), so the docked path is
 * unchanged by construction.
 *
 * The toast SURFACE stays where it is — DockWindowShell mounts each window's
 * `<Toaster>` inside that window's own tree. Only the ROUTING is provided here, so
 * `useHostToast()` inside a detached panel reaches the toaster in the window the
 * user is actually looking at.
 *
 * DOM-LESS SAFETY: `createPortal` throws under react-dom/server, so with no
 * `document` this component renders `null`. Every renderToStaticMarkup test in the
 * repo can therefore mount the room without a jsdom.
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HostWindowRealm } from '../../../utils/hostWindow';
import { ToastRealmProvider } from '../../../utils/hostToast';
import type { DockLiveMount } from './dockMounts';
import type { DockMountRegistry } from './dockMountRegistry';

// Property lookup on globalThis yields undefined instead of throwing (unlike a bare
// identifier), which is what keeps this module importable in Node.
const HAS_DOM = typeof (globalThis as { document?: unknown }).document !== 'undefined';

/**
 * Adoption must happen in the COMMIT phase, before paint, so a moved panel is never
 * visibly missing for a frame. There is no commit phase at all under the server
 * renderer, where useLayoutEffect also warns — hence the isomorphic pick, resolved
 * once at module load rather than per render.
 */
const useCommitEffect = HAS_DOM ? useLayoutEffect : useEffect;

export interface DockPanelMountsProps<P extends string = string> {
  /** The live set, from `resolveLiveMounts`. Order is registry order. */
  live: readonly DockLiveMount<P>[];
  /** The per-room container registry (`useDockMountRegistry`). */
  registry: DockMountRegistry<P>;
  /** The panel render map — the SAME one the zones used to call. */
  renderPanel: (panel: P) => React.ReactNode;
  /** The OS window a zone's slots live in. `null` ⇒ the main window. */
  realmOf: (zoneId: string) => Window | null;
  /** The toaster id for a zone (a dock window's frame name), or undefined. */
  toasterIdOf: (zoneId: string) => string | undefined;
}

export function DockPanelMounts<P extends string = string>({
  live,
  registry,
  renderPanel,
  realmOf,
  toasterIdOf,
}: DockPanelMountsProps<P>): React.ReactElement | null {
  // Release the containers of panels that left the live set. Diffed against the
  // previous pass rather than recomputed from the registry, so a container cached
  // for reuse is not re-released on every commit.
  const prevRef = useRef<P[]>([]);
  const ids = live.map((m) => m.panel);
  useCommitEffect(() => {
    for (const id of prevRef.current) if (!ids.includes(id)) registry.release(id);
    prevRef.current = ids;
  });

  if (!HAS_DOM || live.length === 0) return null;

  return (
    <>
      {live.map(({ panel, zoneId }) => createPortal(
        // Unconditional wrappers — see the header. `HostWindowRealm` takes null and
        // provides REAL_HOST for it, so the docked case is value-identical to having
        // no provider at all and the subtree's SHAPE never changes.
        <HostWindowRealm window={realmOf(zoneId)}>
          <ToastRealmProvider toasterId={toasterIdOf(zoneId)}>
            {renderPanel(panel)}
          </ToastRealmProvider>
        </HostWindowRealm>,
        registry.container(panel) as unknown as Element,
        // The portal KEY is the panel id, never the zone: a move must not change
        // the child's position in this list.
        panel,
      ))}
    </>
  );
}

export default DockPanelMounts;
