/**
 * dockMountRegistry — the imperative half of mount hoisting: one STABLE DOM
 * container per live panel, moved between zone slots by `appendChild`.
 *
 * ── Why a container at all, instead of portalling into the slot ──────────────
 * The obvious fix for "a move remounts the panel" is `createPortal(body, slotEl)`.
 * It does not work. React's `updatePortal` deletes and recreates the portal fiber
 * whenever `stateNode.containerInfo !== portal.containerInfo` — changing a portal's
 * CONTAINER remounts its children. Since the slot element changes on every move,
 * portalling into the slot buys exactly nothing.
 *
 * So the portal target is a container this module owns and NEVER swaps:
 *
 *      React:  createPortal(panelBody, registry.container(id), id)   // never changes
 *      DOM:    destinationSlot.appendChild(registry.container(id))   // the move
 *
 * A move is then one `appendChild` — a DOM reparent, not a React reconciliation.
 * Component state, effects, subscriptions and refs all survive, which is the whole
 * point: RoomVoicePanel's PTT listeners and debounced settings flush, RoomLanPanel's
 * latched failure map and RoomChat's composer draft live in effects and state, not
 * in values that could be lifted.
 *
 * `appendChild` across DOCUMENTS auto-adopts the node (and its subtree) into the
 * destination document, so moving a panel into a torn-off window is the same single
 * call. That is what makes dock ⇄ window moves non-destructive too.
 *
 * ── What does NOT survive, stated rather than discovered ─────────────────────
 * The container is momentarily detached while React deletes the source slot (mutation
 * phase) before the destination's ref attaches (layout phase). Anything derived from
 * LAYOUT dies there:
 *   • scroll offsets — captured and restored around the single `appendChild` here;
 *   • focus — a reparent blurs the focused element. The strip's existing
 *     `focusPanelId` mechanism re-focuses the moved tab, so this is already owned.
 * Everything React holds is untouched.
 *
 * ── DOM-less safety ──────────────────────────────────────────────────────────
 * Nothing dereferences a global at construction: `createElement` is a callback and
 * is only invoked by `container()`, which a renderToStaticMarkup test never reaches
 * (DockPanelMounts renders null with no DOM). The rest of the module talks only to
 * `parentNode` / `appendChild` / `removeChild` / `scrollTop`, which is why the unit
 * test can drive it with a ~20-line fake node and no jsdom.
 */
import { useRef } from 'react';

/**
 * The single node shape this module touches — deliberately loose enough that a real
 * `HTMLElement` satisfies it (so the room can hand `slotRef` straight to a React
 * ref) AND a ~20-line fake satisfies it (so the unit test needs no jsdom).
 * `parentNode` is `unknown` because the DOM types it as `ParentNode`, which carries
 * none of the members below; `parentOf` narrows it in one place.
 */
export interface DockMountNode {
  parentNode?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appendChild(child: any): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeChild(child: any): unknown;
  className?: string;
  scrollTop?: number;
  scrollLeft?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  querySelectorAll?(selector: string): ArrayLike<any>;
}

const parentOf = (n: DockMountNode): DockMountNode | null =>
  (n.parentNode ?? null) as DockMountNode | null;

export interface DockMountRegistry<P extends string = string> {
  /**
   * The stable portal container for `panel`, created on first call and never
   * swapped. Call it during RENDER: every render in a commit precedes every ref
   * callback in that commit, so the container always exists before a slot claims it.
   */
  container(panel: P): DockMountNode;
  /**
   * The callback ref a zone puts on `panel`'s slot. Cached per panel id, so the ref
   * identity is stable across renders and React does not detach/re-attach it on
   * every gossip push.
   */
  slotRef(panel: P): (el: DockMountNode | null) => void;
  /** The panel left the live set: detach its container, keep the node for reuse. */
  release(panel: P): void;
  /**
   * HIDDEN but still mounted. The panel has no slot anywhere, so its container is
   * moved into a limbo node owned by the MAIN document; the React mount, its
   * effects, its state and its subscriptions all keep running (that is the whole
   * point — hiding Voice must not drop push-to-talk).
   *
   * Re-parenting rather than simply leaving the container where the deleted slot
   * left it is what removes a real class of bug: a panel hidden out of a TORN-OFF
   * window has its container inside THAT window's DOM, and when the window closes
   * the container would be stranded in a destroyed document. Restoring is then one
   * `appendChild` out of limbo — hide and show cost exactly what a move costs.
   *
   * Idempotent, and scroll is preserved across the reparent, like `adopt`.
   */
  park(panel: P): void;
  /** Release every panel not in `live`. Convenience for the mount host's diff. */
  retain(live: readonly P[]): void;
  /** Panels this registry has ever built a container for (containers are reused). */
  knownPanels(): P[];
  /** Which element currently holds `panel`'s container, if any. Test only. */
  slotOf(panel: P): DockMountNode | null;
}

export interface DockMountRegistryOptions {
  /** How to make a container. Real caller: `() => document.createElement('div')`. */
  createElement: () => DockMountNode;
  /** Class on the container. `.dock-mount` is `display: contents` (no box). */
  className?: string;
}

/** Capture the scroll offsets a reparent is about to destroy. */
function captureScroll(root: DockMountNode): [DockMountNode, number, number][] {
  const out: [DockMountNode, number, number][] = [];
  const push = (el: DockMountNode): void => {
    const top = typeof el.scrollTop === 'number' ? el.scrollTop : 0;
    const left = typeof el.scrollLeft === 'number' ? el.scrollLeft : 0;
    if (top !== 0 || left !== 0) out.push([el, top, left]);
  };
  push(root);
  if (typeof root.querySelectorAll === 'function') {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i += 1) push(all[i]);
  }
  return out;
}

function restoreScroll(saved: readonly [DockMountNode, number, number][]): void {
  for (const [el, top, left] of saved) {
    if (typeof el.scrollTop === 'number') el.scrollTop = top;
    if (typeof el.scrollLeft === 'number') el.scrollLeft = left;
  }
}

export function createDockMountRegistry<P extends string = string>(
  opts: DockMountRegistryOptions,
): DockMountRegistry<P> {
  const className = opts.className ?? 'dock-mount';
  const containers = new Map<P, DockMountNode>();
  const refs = new Map<P, (el: DockMountNode | null) => void>();
  const slots = new Map<P, DockMountNode>();

  const container = (panel: P): DockMountNode => {
    let c = containers.get(panel);
    if (!c) {
      c = opts.createElement();
      c.className = className;
      containers.set(panel, c);
    }
    return c;
  };

  const adopt = (panel: P, el: DockMountNode): void => {
    const c = container(panel);
    // Already in the right place: `dragover` and gossip pushes re-run refs often,
    // and an unconditional appendChild would reparent (and therefore reset scroll)
    // for nothing.
    if (parentOf(c) === el) return;
    const saved = captureScroll(c);
    el.appendChild(c);
    restoreScroll(saved);
  };

  const slotRef = (panel: P): ((el: DockMountNode | null) => void) => {
    let ref = refs.get(panel);
    if (!ref) {
      ref = (el: DockMountNode | null): void => {
        if (el === null) {
          // The slot is going away — the zone unmounted, or the panel moved and
          // React is deleting the source slot. The detach ALWAYS runs before the
          // destination's attach (mutation phase, then layout phase), so doing
          // anything here would just be undone one phase later. Leaving the
          // container where it is also means a panel whose zone is not rendered at
          // all is simply parked: mounted, running, invisible, adopted the instant
          // a slot appears. HIDING makes that state explicit and durable — see
          // `park`, which additionally rescues the container from a document that
          // is about to die.
          slots.delete(panel);
          return;
        }
        slots.set(panel, el);
        adopt(panel, el);
      };
      refs.set(panel, ref);
    }
    return ref;
  };

  /**
   * Where parked containers wait. Created lazily by `opts.createElement`, i.e. in
   * the MAIN document, and never attached to anything — a detached node is not
   * rendered, not measured and not in the tab order, which is precisely what
   * "hidden but running" needs.
   */
  let limbo: DockMountNode | null = null;

  const park = (panel: P): void => {
    const c = containers.get(panel);
    if (!c) return; // never mounted — nothing to park
    if (!limbo) {
      limbo = opts.createElement();
      limbo.className = `${className}-limbo`;
    }
    slots.delete(panel);
    if (parentOf(c) === limbo) return; // already parked
    const saved = captureScroll(c);
    limbo.appendChild(c);
    restoreScroll(saved);
  };

  const release = (panel: P): void => {
    const c = containers.get(panel);
    slots.delete(panel);
    if (!c) return;
    const p = parentOf(c);
    if (p) p.removeChild(c);
    // The node itself is KEPT: the panel may come back (a tab switch on a keep-alive
    // zone, a dock-back), and reusing it means the registry never grows beyond the
    // panel count.
  };

  return {
    container,
    slotRef,
    release,
    park,
    retain(live) {
      for (const panel of Array.from(containers.keys())) {
        if (!live.includes(panel)) release(panel);
      }
    },
    knownPanels: () => Array.from(containers.keys()),
    slotOf: (panel) => slots.get(panel) ?? null,
  };
}

/**
 * The registry for one room, held in a REF rather than in state: it is imperative
 * DOM bookkeeping, and a move must cost zero extra renders (invariant C — the room
 * already re-renders on every gossip push).
 *
 * `document.createElement` is resolved lazily inside the callback, so constructing
 * the registry is safe in the DOM-less test renderer; nothing calls it there
 * because DockPanelMounts renders null with no DOM.
 */
export function useDockMountRegistry<P extends string = string>(
  className = 'dock-mount',
): DockMountRegistry<P> {
  const ref = useRef<DockMountRegistry<P> | null>(null);
  if (!ref.current) {
    ref.current = createDockMountRegistry<P>({
      createElement: () => (globalThis as unknown as { document: Document })
        .document.createElement('div') as unknown as DockMountNode,
      className,
    });
  }
  return ref.current;
}
