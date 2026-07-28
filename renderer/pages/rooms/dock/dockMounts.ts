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
 *   live = { the active panel of each zone } ∪ { every keep-alive panel in a zone }
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
  /** Insertion order, used for panels the registry order does not mention. */
  const seen: P[] = [];

  for (const z of zones) {
    const active = resolveZoneActive(z.panels, z.active);
    for (const panel of z.panels) {
      if (zoneOf.has(panel)) continue;
      if (panel !== active && !keepAlive(panel)) continue;
      zoneOf.set(panel, z.zoneId);
      seen.push(panel);
    }
  }

  const out: DockLiveMount<P>[] = [];
  const emitted = new Set<P>();
  for (const panel of order) {
    const zoneId = zoneOf.get(panel);
    if (zoneId === undefined || emitted.has(panel)) continue;
    emitted.add(panel);
    out.push({ panel, zoneId });
  }
  // Anything the caller's `order` did not mention still gets mounted — a panel that
  // is missing from the registry order is a wiring bug, and dropping its mount
  // would present it as an empty slot instead of failing loudly in review.
  for (const panel of seen) {
    if (emitted.has(panel)) continue;
    emitted.add(panel);
    out.push({ panel, zoneId: zoneOf.get(panel) as string });
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
