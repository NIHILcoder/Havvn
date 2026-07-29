/**
 * dockWindowChrome — the IPC half of a torn-off window's title bar.
 *
 * Kept OUT of DockWindowShell on purpose. The shell is plain markup that renders
 * from a node harness with no DOM, no preload bridge and no I18nProvider; the
 * moment it reached for `window.api` it would stop being testable that way. So the
 * shell takes a `chrome` object of already-resolved values and callbacks, and this
 * module is where those come from.
 *
 * WHY BY FRAME NAME, and not "the window I am in". A dock pop-out is an
 * about:blank child that the ROOM window portals DOM into: the React tree — this
 * hook included — runs in the main renderer's realm. `window.api` is the room
 * window's bridge, so `win:minimize` here would minimise the room, and in main
 * `event.sender` is the room window for every send. The pool frame name
 * (`havvn-dock-1`) is the only address that names the child, and it is already the
 * window's identity everywhere else in this folder.
 *
 * There is no `close` here: closing a dock window has always meant "the group
 * comes home", and that path already exists end to end (onDockBack → the owner
 * unmounts the host → usePopout's cleanup closes the OS window). A second
 * teardown route into the same place is exactly what the host's header comment
 * refuses, so the ✕ reuses the dock-back handler instead of an IPC of its own.
 */
import { useEffect, useState } from 'react';

/**
 * Is this pool slot's window currently maximised?
 *
 * @param frameName the pool slot (`havvn-dock-1`…) — the OS window's address.
 * @param live      whether the window exists right now. Slots are RECYCLED, so a
 *                  stale `true` from the previous occupant would draw the restore
 *                  glyph on a brand-new window; re-querying on every transition is
 *                  what keeps the glyph honest across a dock-back/tear-off cycle.
 */
export function useDockWindowMaximized(frameName: string, live: boolean): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!live) {
      // Not merely tidy: the next window in this slot opens un-maximised (main
      // restores the saved NORMAL bounds), so carrying the flag over would show
      // "restore" on a window that has never been maximised.
      setMaximized(false);
      return;
    }
    // No preload bridge (tests, a stripped harness): the bar simply never
    // updates, which is inert — the buttons are no-ops there anyway.
    const api = window.api?.win;
    if (!api?.popoutIsMaximized) return;

    let alive = true;
    api.popoutIsMaximized(frameName).then((m) => { if (alive) setMaximized(m); }).catch(() => { /* window died mid-query */ });
    // Main pushes to the OWNER's webContents (this realm), and one listener sees
    // every slot — hence the frame-name filter rather than a per-window channel.
    const off = api.onPopoutMaximizeChange?.((p) => {
      if (p.frameName === frameName) setMaximized(p.maximized);
    });
    return () => { alive = false; off?.(); };
  }, [frameName, live]);

  return maximized;
}

/** Minimise this pool slot's window. Inert without the preload bridge. */
export function minimizeDockWindow(frameName: string): void {
  try { window.api?.win?.popoutMinimize?.(frameName); } catch { /* no bridge */ }
}

/** Maximise/restore this pool slot's window. Inert without the preload bridge. */
export function toggleMaximizeDockWindow(frameName: string): void {
  try { window.api?.win?.popoutToggleMaximize?.(frameName); } catch { /* no bridge */ }
}
