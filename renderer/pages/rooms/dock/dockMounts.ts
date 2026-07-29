/**
 * dockMounts — WHICH panels are mounted right now, decided ONCE for the whole dock.
 *
 * ── The bug this exists to kill ──────────────────────────────────────────────
 * Before P4 every `<DockZone>` decided its own mount set (`resolveDockMount` +
 * a per-instance `aliveRef`). Two zones are two component instances with two refs,
 * so "keep this panel alive" could never span a MOVE: dragging Chat from the right
 * column to the centre unmounted it in one subtree and mounted a fresh instance in
 * the other, discarding exactly the state `keepAlive` was introduced to protect
 * (the composer draft, the voice panel's PTT listeners and debounced settings
 * flush, the LAN panel's latched failure map). The alive set was scoped to the
 * wrong thing by construction.
 *
 * So the decision moves UP: the owner resolves the live set for every zone at once
 * and mounts each live panel exactly once, from a tree position no dock change can
 * disturb (see DockPanelMounts.tsx). The zones then render SLOTS, and a move is a
 * DOM reparent instead of a React remount.
 *
 * ── The policy is unchanged (P1, verbatim, one level up) ─────────────────────
 *   live = { the active panel of each zone } ∪ { every keep-alive panel in a zone
 *                                                OR HIDDEN }
 *
 * The last two words are the only widening this file has ever had, and they are what
 * makes HIDING a panel safe: a hidden panel is in no zone at all (that is the model's
 * whole encoding), so without them hiding Voice would UNMOUNT it — silently tearing
 * down the PTT listeners and the voice-warning subscription of a user who is in a
 * call, which is exactly the failure `keepAlive` exists to prevent. Hidden panels
 * arrive as one PARKED pseudo-zone (`parkedMountZone`), and the rule below then
 * mounts precisely the keep-alive ones. A hidden panel is therefore never worse off
 * than a panel whose tab is simply not selected — which is the property that makes
 * hiding a LAYOUT act rather than a lifecycle one.
 *
 * which is precisely `resolveDockMount`'s rule, unioned across zones:
 *   • a NON-keep-alive panel that is not its zone's active tab is NOT mounted —
 *     switching tabs still unmounts it, and "hidden" still means "released";
 *   • a keep-alive panel is mounted EAGERLY, from the first resolve, whether or not
 *     it has ever been selected. Lazy mounting would mean a user whose saved tab is
 *     People never mounts the voice panel and silently stops receiving voice
 *     warnings — behaviour that was always-on before the rail became a dock.
 *
 * ── History-free, deliberately ───────────────────────────────────────────────
 * There is no `alive` set threaded through this function. Because keep-alive is
 * EAGER, "has it been alive before?" was never an input — `alive` was derivable
 * from the layout on every pass, and the per-zone ref was vestigial bookkeeping
 * that only existed to survive re-renders. A pure function of the layout is
 * testable with no DOM, cannot disagree with itself across zones, and cannot leak a
 * mount for a panel that has left every zone.
 *
 * ONE decider, not two: the zone that renders a slot and the host that renders a
 * mount must agree, or the user gets an empty slot (mount missing) or an invisible
 * running panel (slot missing). Both read the SAME result of this function, and
 * both repair a stale `active` the same way (rule 1 of `resolveDockMount`), so they
 * cannot drift.
 */

/** One zone as the resolver sees it. Deliberately not the model's `DockLayout`. */
export interface DockMountZone<P extends string = string> {
  /** Zone id — the only field a MOVE changes for a panel. */
  zoneId: string;
  /** Panels docked here, in tab order. May be empty (v2 allows an empty zone). */
  panels: readonly P[];
  /** The selected panel; '' iff the zone is empty. Repaired here, not trusted. */
  active: P | '';
  /**
   * PARKED: these panels have NO SLOT anywhere (they are hidden). Mount only the
   * keep-alive members and resolve NO active panel.
   *
   * The flag is not decoration. Without it `resolveZoneActive`'s "fall back to
   * panels[0]" would mount the FIRST hidden panel even when it is not keep-alive,
   * and that mount would then portal into a container no slot will ever adopt —
   * a running panel nobody can see, which is the exact state the one-decider rule
   * exists to make impossible.
   */
  parked?: boolean;
}

/** One mounted panel and where it currently lives. */
export interface DockLiveMount<P extends string = string> {
  /**
   * Panel id. This is the portal KEY and the mount registry's key, and it is what
   * a move must NOT change — that is the whole architecture in one field.
   */
  panel: P;
  /** The zone whose slot this panel's container is parked in. */
  zoneId: string;
  /**
   * This mount came from a PARKED zone: it is mounted and running, but no slot
   * exists for it. The host detaches its container into limbo (`registry.park`)
   * instead of leaving it inside a slot that is being deleted.
   */
  parked?: boolean;
}

/**
 * The zone id parked mounts carry. Not a real zone: `liveMountsIn` can never match
 * it (no DockZone renders with this id), and both `isDockedZone` and `isWindowZone`
 * are false for it — so the owner's `realmOf`/`toasterIdOf` already resolve it to
 * the main realm with no toaster, which is correct for a panel with no window.
 */
export const DOCK_PARKED_ZONE = '__parked';

/** The hidden panels as one pseudo-zone, ready to append to `resolveLiveMounts`. */
export function parkedMountZone<P extends string>(hidden: readonly P[]): DockMountZone<P> {
  return { zoneId: DOCK_PARKED_ZONE, panels: hidden, active: '', parked: true };
}

/**
 * Repair a zone's active panel the same way `resolveDockMount` does: an id that is
 * not in the zone falls back to the first panel rather than mounting nothing.
 * Exported so the two deciders provably share it.
 */
export function resolveZoneActive<P extends string>(
  panels: readonly P[],
  active: P | '',
): P | '' {
  return panels.includes(active as P) ? (active as P) : (panels[0] ?? '');
}

/**
 * THE live set. Returns one entry per mounted panel, ordered by `order` (the panel
 * registry's order) so the portal children never reorder — a reorder would be a
 * React tree-position change, which is the very thing this design avoids.
 *
 * `keepAlive` is asked per panel rather than read off a field so the resolver stays
 * independent of the registry's shape (and so a test can vary it in one line).
 *
 * A panel listed in two zones (which the model forbids) resolves to the FIRST zone
 * in `zones` order, so a corrupt layout yields one mount, never two.
 */
export function resolveLiveMounts<P extends string>(
  zones: readonly DockMountZone<P>[],
  keepAlive: (panel: P) => boolean,
  order: readonly P[] = [],
): DockLiveMount<P>[] {
  /** panel -> zone, first zone wins. */
  const zoneOf = new Map<P, string>();
  /** Panels whose zone has no slots at all. */
  const parked = new Set<P>();
  /** Insertion order, used for panels the registry order does not mention. */
  const seen: P[] = [];

  for (const z of zones) {
    // A parked zone resolves NO active panel: it has no slots, so "the tab this zone
    // shows" is meaningless there and only keep-alive membership can mount anything.
    const active = z.parked ? '' : resolveZoneActive(z.panels, z.active);
    for (const panel of z.panels) {
      if (zoneOf.has(panel)) continue;
      if (panel !== active && !keepAlive(panel)) continue;
      zoneOf.set(panel, z.zoneId);
      if (z.parked) parked.add(panel);
      seen.push(panel);
    }
  }

  const emit = (panel: P): DockLiveMount<P> => {
    const m: DockLiveMount<P> = { panel, zoneId: zoneOf.get(panel) as string };
    if (parked.has(panel)) m.parked = true;
    return m;
  };

  const out: DockLiveMount<P>[] = [];
  const emitted = new Set<P>();
  for (const panel of order) {
    if (zoneOf.get(panel) === undefined || emitted.has(panel)) continue;
    emitted.add(panel);
    out.push(emit(panel));
  }
  // Anything the caller's `order` did not mention still gets mounted — a panel that
  // is missing from the registry order is a wiring bug, and dropping its mount
  // would present it as an empty slot instead of failing loudly in review.
  for (const panel of seen) {
    if (emitted.has(panel)) continue;
    emitted.add(panel);
    out.push(emit(panel));
  }
  return out;
}

/** The panels mounted in one zone, in live-set order. Feeds `DockZone.mounts`. */
export function liveMountsIn<P extends string>(
  live: readonly DockLiveMount<P>[],
  zoneId: string,
): P[] {
  return live.filter((m) => m.zoneId === zoneId).map((m) => m.panel);
}

/** Where a mounted panel currently is, or undefined when it is not mounted. */
export function liveZoneOf<P extends string>(
  live: readonly DockLiveMount<P>[],
  panel: P,
): string | undefined {
  return live.find((m) => m.panel === panel)?.zoneId;
}
