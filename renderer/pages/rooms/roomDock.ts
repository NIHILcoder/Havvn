/**
 * roomDock — the room's own dock decisions, as pure functions.
 *
 * RoomsPage.tsx is a 4000-line component file with no jsdom in the test setup, so
 * anything decided in there is decided invisibly. These two rules are load-bearing
 * enough that "it looked right when I dragged it" is not evidence:
 *
 *   • `soloHandleZone` — WHERE the strip-less zone's move affordance goes. It has to
 *     agree with DockZone's own strip-hiding rule exactly: a disagreement either
 *     leaves a solo panel with no way out at all (no strip AND no handle), or draws
 *     two move affordances one row apart.
 *   • `pttWindowSet` — which OS windows push-to-talk listens in. A key reaches only
 *     the FOCUSED window, so a missing entry is a dead PTT key in whichever window
 *     the user happens to be typing in, with nothing on screen to say so.
 *
 * Both are pure and DOM-free; the Window arguments are typed structurally so the
 * test can pass plain objects.
 */
import {
  DOCK_SOLO_HOST_IDS, isDockedZone, zonePanels, zoneOfPanel,
} from './dock/dockModel';
import type { DockDockedZoneId, DockLayout, DockPanelId } from './dock/dockModel';

/**
 * The docked zone whose TAB STRIP is hidden because `panel` is alone in it and
 * hosts its own header row — i.e. where a `DockSoloHandle` must be rendered — or
 * null when the strip is showing and owns the gesture.
 *
 * This mirrors `DockZone`'s `soloHost` test one for one:
 *     panels.length === 1 && soloHostIds.includes(panels[0])
 * with `soloHostIds` supplied for DOCKED zones only. A window zone always keeps its
 * strip (there is no pre-P3 look to preserve there, and the strip is the way home),
 * so this returns null for one.
 */
export function soloHandleZone(l: DockLayout, panel: DockPanelId): DockDockedZoneId | null {
  if (!DOCK_SOLO_HOST_IDS.includes(panel)) return null;
  const zone = zoneOfPanel(l, panel);
  if (!zone || !isDockedZone(zone)) return null;
  const ids = zonePanels(l, zone);
  return ids.length === 1 && ids[0] === panel ? zone : null;
}

/** The subset of `Window` this module reads — so a test needs no DOM. */
export interface PttWindow { closed?: boolean }

/**
 * Every window push-to-talk must bind, de-duplicated and in a stable order.
 *
 * `main` first, always: the docked case has to keep working exactly as it did.
 * Then every LIVE torn-off group from the pop-out registry — not just the voice
 * panel's own host, because the window the user is typing in is very often not the
 * one Voice is in (Voice in the rail, Chat on the second monitor). A closed or
 * missing window is dropped rather than bound: its listeners would be gone with its
 * document anyway, and holding the reference would keep a dead Window alive for the
 * effect's lifetime.
 */
export function pttWindowSet<W extends PttWindow>(
  main: W,
  extra: readonly (W | null | undefined)[],
): W[] {
  const out: W[] = [main];
  for (const w of extra) {
    if (!w || w.closed) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}
