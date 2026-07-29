import { describe, it, expect, beforeEach } from 'vitest';

import {
  DOCK_DND_TYPE,
  beginDockDrag,
  currentDockDrag,
  dockDragSnapshot,
  encodeDockDrag,
  endDockDrag,
  insertionIndexAt,
  isDockDrag,
  isUsableDragPoint,
  markerTargetFor,
  noteDockDragPoint,
  parseDockDragPayload,
  resolveDockDrop,
  setAttrIfChanged,
  setDockDragTab,
  setDockInsertMarker,
  setDockDragOver,
} from './dockDrag';

/**
 * The attribute writers are the whole of the drag's render path (CSS reads them,
 * React never does), so they are exercised against a four-method stand-in rather
 * than left to review — there is no jsdom in this repo.
 */
class FakeEl {
  attrs = new Map<string, string>();
  writes = 0;
  getAttribute(n: string): string | null { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); this.writes += 1; }
  hasAttribute(n: string): boolean { return this.attrs.has(n); }
  removeAttribute(n: string): void { this.attrs.delete(n); this.writes += 1; }
}
const el = (): FakeEl & Element => new FakeEl() as unknown as FakeEl & Element;

describe('the wire format', () => {
  it('is one lowercase private type, so Chromium can match it on read', () => {
    // Chromium normalises dataTransfer.types; a mixed-case type could never match.
    expect(DOCK_DND_TYPE).toBe(DOCK_DND_TYPE.toLowerCase());
    // ...and it mirrors RoomsPage's FILE_DND_TYPE shape so one grep finds both.
    expect(DOCK_DND_TYPE.startsWith('text/havvn-')).toBe(true);
  });

  it('round-trips a payload', () => {
    const raw = encodeDockDrag({ panel: 'chat', zone: 'left', win: 'main' });
    expect(parseDockDragPayload(raw)).toEqual({ t: 'havvn-dock', panel: 'chat', zone: 'left', win: 'main' });
  });

  it('fails CLOSED on anything it does not recognise', () => {
    expect(parseDockDragPayload(null)).toBeNull();
    expect(parseDockDragPayload('')).toBeNull();
    expect(parseDockDragPayload('not json')).toBeNull();
    expect(parseDockDragPayload('"a string"')).toBeNull();
    expect(parseDockDragPayload('null')).toBeNull();
    expect(parseDockDragPayload('[1,2]')).toBeNull();
    // an untagged object is somebody else's payload, not a lenient version of ours
    expect(parseDockDragPayload('{"panel":"chat","zone":"left","win":"main"}')).toBeNull();
    expect(parseDockDragPayload('{"t":"other","panel":"chat","zone":"left","win":"main"}')).toBeNull();
    // truncated / wrong-typed fields
    expect(parseDockDragPayload('{"t":"havvn-dock","panel":"chat","zone":"left"}')).toBeNull();
    expect(parseDockDragPayload('{"t":"havvn-dock","panel":"","zone":"left","win":"main"}')).toBeNull();
    expect(parseDockDragPayload('{"t":"havvn-dock","panel":3,"zone":"left","win":"main"}')).toBeNull();
  });

  it('drops unknown keys rather than carrying them through', () => {
    const p = parseDockDragPayload('{"t":"havvn-dock","panel":"chat","zone":"left","win":"main","x":1}');
    expect(p).toEqual({ t: 'havvn-dock', panel: 'chat', zone: 'left', win: 'main' });
  });
});

describe('isDockDrag', () => {
  it('accepts our type from an array or a DOMStringList-alike', () => {
    expect(isDockDrag([DOCK_DND_TYPE])).toBe(true);
    expect(isDockDrag([DOCK_DND_TYPE.toUpperCase()])).toBe(true); // read-normalised
    const list = { length: 2, 0: 'text/plain', 1: DOCK_DND_TYPE } as unknown as DOMStringList;
    expect(isDockDrag(list)).toBe(true);
  });

  it('lets an OS FILE drag fall straight through — the strip must never eat one', () => {
    expect(isDockDrag(['Files'])).toBe(false);
    expect(isDockDrag(['text/havvn-fileid'])).toBe(false); // the room's own file drag
    expect(isDockDrag(['text/plain'])).toBe(false);
    expect(isDockDrag([])).toBe(false);
    expect(isDockDrag(null)).toBe(false);
    expect(isDockDrag(undefined)).toBe(false);
  });
});

describe('insertionIndexAt', () => {
  // three 100px tabs at x = 0, 100, 200 → midpoints 50, 150, 250
  const rects = [{ left: 0, width: 100 }, { left: 100, width: 100 }, { left: 200, width: 100 }];

  it('counts the tabs whose midpoint the pointer has passed', () => {
    expect(insertionIndexAt(rects, -20)).toBe(0);
    expect(insertionIndexAt(rects, 10)).toBe(0);
    expect(insertionIndexAt(rects, 60)).toBe(1);
    expect(insertionIndexAt(rects, 160)).toBe(2);
    expect(insertionIndexAt(rects, 400)).toBe(3); // past the last tab → append
  });

  it('puts an exact midpoint hit BEFORE that tab (no half-index)', () => {
    expect(insertionIndexAt(rects, 50)).toBe(0);
    expect(insertionIndexAt(rects, 150)).toBe(1);
  });

  it('is 0 for an empty strip', () => {
    expect(insertionIndexAt([], 123)).toBe(0);
  });
});

describe('markerTargetFor', () => {
  it('marks the tab at the index, or the LAST tab when appending', () => {
    expect(markerTargetFor(0, 3)).toEqual({ tabIndex: 0, side: 'before' });
    expect(markerTargetFor(2, 3)).toEqual({ tabIndex: 2, side: 'before' });
    expect(markerTargetFor(3, 3)).toEqual({ tabIndex: 2, side: 'after' });
  });

  it('clamps a bogus index instead of marking nothing', () => {
    expect(markerTargetFor(9, 3)).toEqual({ tabIndex: 2, side: 'after' });
    expect(markerTargetFor(-4, 3)).toEqual({ tabIndex: 0, side: 'before' });
  });

  it('has nothing to mark in an empty strip', () => {
    expect(markerTargetFor(0, 0)).toBeNull();
  });
});

describe('resolveDockDrop — is this drop legal, and what does it mean', () => {
  const ctx = (over: Partial<Parameters<typeof resolveDockDrop>[1]> = {}) => ({
    zone: 'left', win: 'main', panels: ['voice', 'lan', 'people'], index: 0, ...over,
  });
  const payload = (over: Partial<{ panel: string; zone: string; win: string }> = {}) =>
    parseDockDragPayload(encodeDockDrag({ panel: 'chat', zone: 'right', win: 'main', ...over }));

  it('refuses an unreadable payload', () => {
    expect(resolveDockDrop(null, ctx())).toBeNull();
  });

  it('refuses a payload stamped with a DIFFERENT window', () => {
    // Cross-window tab drag is impossible, so such a payload is stale or forged.
    expect(resolveDockDrop(payload({ win: 'havvn-dock-1' }), ctx({ win: 'main' }))).toBeNull();
  });

  it('reads a panel from another zone as a move, at the pointer index', () => {
    expect(resolveDockDrop(payload(), ctx({ index: 2 }))).toEqual({
      kind: 'move', panel: 'chat', from: 'right', to: 'left', index: 2,
    });
  });

  it('preserves a null index (a zone-body drop) so the model appends', () => {
    expect(resolveDockDrop(payload(), ctx({ index: null }))?.index).toBeNull();
  });

  it('clamps an out-of-range index rather than producing a hole', () => {
    expect(resolveDockDrop(payload(), ctx({ index: 99 }))?.index).toBe(3);
    expect(resolveDockDrop(payload(), ctx({ index: -5 }))?.index).toBe(0);
  });

  it('treats a drop on either side of the tab\'s OWN slot as a no-op', () => {
    // 'lan' sits at index 1; insertion at 1 or 2 leaves the order unchanged.
    const p = payload({ panel: 'lan', zone: 'left' });
    expect(resolveDockDrop(p, ctx({ index: 1 }))?.kind).toBe('noop');
    expect(resolveDockDrop(p, ctx({ index: 2 }))?.kind).toBe('noop');
  });

  it('converts a reorder insertion point into a final index', () => {
    const p = payload({ panel: 'voice', zone: 'left' }); // at index 0
    // insertion at 2 removes voice first, so the landing index is 1
    expect(resolveDockDrop(p, ctx({ index: 2 }))).toEqual({
      kind: 'reorder', panel: 'voice', from: 'left', to: 'left', index: 1,
    });
    // dragging leftwards needs no adjustment
    const q = payload({ panel: 'people', zone: 'left' }); // at index 2
    expect(resolveDockDrop(q, ctx({ index: 0 }))).toEqual({
      kind: 'reorder', panel: 'people', from: 'left', to: 'left', index: 0,
    });
  });

  it('resolves a null index in the tab\'s own zone as "move to the end"', () => {
    expect(resolveDockDrop(payload({ panel: 'voice', zone: 'left' }), ctx({ index: null })))
      .toEqual({ kind: 'reorder', panel: 'voice', from: 'left', to: 'left', index: 2 });
    // ...and as a no-op when it is already last
    expect(resolveDockDrop(payload({ panel: 'people', zone: 'left' }), ctx({ index: null }))?.kind)
      .toBe('noop');
  });

  it('believes MEMBERSHIP over a stale payload zone', () => {
    // The payload claims 'right', but the panel is listed here: it is a reorder.
    const p = payload({ panel: 'voice', zone: 'right' });
    expect(resolveDockDrop(p, ctx({ index: 3 }))?.kind).toBe('reorder');
  });

  it('handles a drop into an EMPTY zone', () => {
    expect(resolveDockDrop(payload(), ctx({ panels: [], index: 0 }))).toEqual({
      kind: 'move', panel: 'chat', from: 'right', to: 'left', index: 0,
    });
  });
});

describe('setAttrIfChanged', () => {
  it('writes once and then stays quiet — dragover fires on a stationary pointer', () => {
    const e = el();
    setAttrIfChanged(e, 'data-dock-over', '');
    setAttrIfChanged(e, 'data-dock-over', '');
    setAttrIfChanged(e, 'data-dock-over', '');
    expect(e.writes).toBe(1);
    expect(e.getAttribute('data-dock-over')).toBe('');
  });

  it('removes on null, and only when the attribute is there', () => {
    const e = el();
    setAttrIfChanged(e, 'x', 'a');
    setAttrIfChanged(e, 'x', null);
    expect(e.hasAttribute('x')).toBe(false);
    const before = e.writes;
    setAttrIfChanged(e, 'x', null);
    expect(e.writes).toBe(before);
  });
});

describe('the drag session', () => {
  beforeEach(() => { endDockDrag(); });
  const start = { startX: 500, startY: 400 };

  it('remembers what is being dragged (getData() is unreadable during dragover)', () => {
    expect(currentDockDrag()).toBeNull();
    const s = beginDockDrag({ panel: 'chat', from: 'right', win: 'main', ...start });
    expect(currentDockDrag()).toEqual(s);
    expect(s.panel).toBe('chat');
  });

  it('bumps `seq` per drag, so a strip remeasures its tab rects exactly once', () => {
    const a = beginDockDrag({ panel: 'chat', from: 'right', win: 'main', ...start });
    const b = beginDockDrag({ panel: 'lan', from: 'left', win: 'main', ...start });
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('keeps ONE lit strip and ONE marker — crossing strips cannot leave two', () => {
    const a = el(); const b = el();
    setDockDragOver(a);
    setDockDragOver(b);
    expect(a.hasAttribute('data-dock-over')).toBe(false);
    expect(b.hasAttribute('data-dock-over')).toBe(true);

    const t1 = el(); const t2 = el();
    setDockInsertMarker(t1, 'before');
    setDockInsertMarker(t2, 'after');
    expect(t1.hasAttribute('data-dock-insert')).toBe(false);
    expect(t2.getAttribute('data-dock-insert')).toBe('after');
    // the same tab flipping sides is one attribute change, not a clear + set
    setDockInsertMarker(t2, 'before');
    expect(t2.getAttribute('data-dock-insert')).toBe('before');
  });

  it('clears every mark on end — a cancelled drag must not strand one', () => {
    const tab = el(); const strip = el(); const marker = el();
    beginDockDrag({ panel: 'chat', from: 'right', win: 'main', ...start });
    setDockDragTab(tab);
    setDockDragOver(strip);
    setDockInsertMarker(marker, 'before');

    endDockDrag(); // this is what dragend calls on Esc-cancel / drop-outside

    expect(currentDockDrag()).toBeNull();
    expect(tab.hasAttribute('data-dock-dragging')).toBe(false);
    expect(strip.hasAttribute('data-dock-over')).toBe(false);
    expect(marker.hasAttribute('data-dock-insert')).toBe(false);
  });

  it('is idempotent, because dragend AND drop both call it', () => {
    const tab = el();
    beginDockDrag({ panel: 'chat', from: 'right', win: 'main', ...start });
    setDockDragTab(tab);
    endDockDrag();
    expect(() => endDockDrag()).not.toThrow();
    expect(currentDockDrag()).toBeNull();
  });

  it('cleans up the previous drag when a new one starts', () => {
    const tab = el();
    beginDockDrag({ panel: 'chat', from: 'right', win: 'main', ...start });
    setDockDragTab(tab);
    beginDockDrag({ panel: 'lan', from: 'left', win: 'main', ...start });
    expect(tab.hasAttribute('data-dock-dragging')).toBe(false);
  });
});

describe('the tear-off bookkeeping the session carries', () => {
  beforeEach(() => { endDockDrag(); });
  const begin = () => beginDockDrag({ panel: 'chat', from: 'right', win: 'main', startX: 500, startY: 400 });

  it('records the dragstart point — the origin of the distance test', () => {
    const s = begin();
    expect([s.startX, s.startY]).toEqual([500, 400]);
    expect(dockDragSnapshot()).toMatchObject({ panel: 'chat', startX: 500, startY: 400 });
  });

  it('seeds tracking from the start point, so a drag that never moves measures zero', () => {
    begin();
    const snap = dockDragSnapshot()!;
    expect([snap.lastX, snap.lastY]).toEqual([500, 400]);
    expect(snap.moved).toBe(false);
    expect(snap.sawButtonsDown).toBe(false);
  });

  it('follows the pointer through `drag` — the fallback when dragend reports 0,0', () => {
    begin();
    noteDockDragPoint(900, 700, 1);
    noteDockDragPoint(1200, 900, 1);
    expect(dockDragSnapshot()).toMatchObject({ lastX: 1200, lastY: 900, moved: true });
  });

  it('CALIBRATES on the platform rather than assuming it reports buttons', () => {
    begin();
    noteDockDragPoint(900, 700, 0); // a platform that does not populate `buttons`
    expect(dockDragSnapshot()!.sawButtonsDown).toBe(false);
    noteDockDragPoint(910, 700, 1); // ...and one that does
    expect(dockDragSnapshot()!.sawButtonsDown).toBe(true);
    // Once proven, it stays proven: a later 0 is a RELEASE, not a retraction.
    noteDockDragPoint(920, 700, 0);
    expect(dockDragSnapshot()!.sawButtonsDown).toBe(true);
  });

  it('refuses to believe an unusable point, so a 0,0 report cannot poison the fallback', () => {
    begin();
    noteDockDragPoint(900, 700, 1);
    noteDockDragPoint(0, 0, 1);         // Chromium outside-the-window reading
    noteDockDragPoint(NaN, NaN, 1);
    expect(dockDragSnapshot()).toMatchObject({ lastX: 900, lastY: 700, moved: true });
  });

  it('ignores points once the drag is over — a stray event cannot resurrect it', () => {
    begin();
    endDockDrag();
    expect(() => noteDockDragPoint(900, 700, 1)).not.toThrow();
    expect(dockDragSnapshot()).toBeNull();
  });

  it('is null after a DROP — which is how dragend learns a target consumed the drag', () => {
    // drop fires before dragend, and every drop path of ours calls endDockDrag().
    begin();
    endDockDrag();
    expect(dockDragSnapshot()).toBeNull();
  });

  it('starts each drag with clean tracking', () => {
    begin();
    noteDockDragPoint(1200, 900, 1);
    const s = beginDockDrag({ panel: 'lan', from: 'left', win: 'main', startX: 10, startY: 20 });
    expect(dockDragSnapshot()).toMatchObject({
      panel: 'lan', seq: s.seq, lastX: 10, lastY: 20, moved: false, sawButtonsDown: false,
    });
  });
});

describe('isUsableDragPoint', () => {
  it('rejects the 0,0 Chromium reports for a drop outside the window', () => {
    expect(isUsableDragPoint(0, 0)).toBe(false);
    expect(isUsableDragPoint(NaN, 5)).toBe(false);
    expect(isUsableDragPoint(5, Infinity)).toBe(false);
  });

  it('accepts everything else, including a real point on an axis', () => {
    expect(isUsableDragPoint(0, 40)).toBe(true);
    expect(isUsableDragPoint(-1920, 300)).toBe(true); // a monitor left of the primary
  });
});
