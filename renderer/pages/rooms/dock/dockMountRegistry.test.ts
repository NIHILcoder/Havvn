import { describe, it, expect } from 'vitest';

import { createDockMountRegistry, type DockMountNode } from './dockMountRegistry';

/**
 * A ~20-line stand-in for the four DOM facts the registry actually uses. The repo
 * has no jsdom (renderer tests are renderToStaticMarkup strings), and the whole
 * point of splitting the imperative half out is that it is provable without one.
 */
interface FakeNode extends DockMountNode {
  readonly kids: FakeNode[];
  readonly doc: string;
  parentNode: FakeNode | null;
  scrollTop: number;
  scrollLeft: number;
}

const node = (doc = 'main'): FakeNode => {
  const self: FakeNode = {
    kids: [],
    doc,
    parentNode: null,
    scrollTop: 0,
    scrollLeft: 0,
    className: undefined,
    appendChild(child: DockMountNode) {
      const c = child as FakeNode;
      if (c.parentNode) c.parentNode.removeChild(c);
      self.kids.push(c);
      c.parentNode = self;
      return c;
    },
    removeChild(child: DockMountNode) {
      const i = self.kids.indexOf(child as FakeNode);
      if (i >= 0) self.kids.splice(i, 1);
      (child as FakeNode).parentNode = null;
      return child;
    },
  };
  return self;
};

const registry = () => {
  let made = 0;
  const reg = createDockMountRegistry<'chat' | 'voice'>({
    createElement: () => { made += 1; return node(); },
    className: 'dock-mount',
  });
  return { reg, made: () => made };
};

describe('createDockMountRegistry — the container is the thing that never changes', () => {
  it('builds one container per panel, lazily, and reuses it forever', () => {
    const { reg, made } = registry();
    expect(made()).toBe(0);           // nothing is built until a panel is live
    const a = reg.container('chat');
    const b = reg.container('chat');
    expect(a).toBe(b);
    expect(made()).toBe(1);
    reg.container('voice');
    expect(made()).toBe(2);
    expect(reg.knownPanels().sort()).toEqual(['chat', 'voice']);
  });

  it('gives the container the class that makes it box-less', () => {
    const { reg } = registry();
    expect(reg.container('chat').className).toBe('dock-mount');
  });

  it('hands out ONE ref identity per panel, so React never re-runs it needlessly', () => {
    const { reg } = registry();
    expect(reg.slotRef('chat')).toBe(reg.slotRef('chat'));
    expect(reg.slotRef('chat')).not.toBe(reg.slotRef('voice'));
  });
});

describe('a move is one appendChild of the SAME node', () => {
  it('adopts the container into the slot that claims it', () => {
    const { reg } = registry();
    const slot = node();
    reg.slotRef('chat')(slot);
    const c = reg.container('chat');
    expect(slot.kids).toEqual([c]);
    expect(reg.slotOf('chat')).toBe(slot);
  });

  it('moves the container between slots without recreating it', () => {
    const { reg, made } = registry();
    const right = node();
    const centre = node();
    reg.slotRef('chat')(right);
    const before = reg.container('chat');

    // The move, exactly as React runs it: the source slot detaches first (mutation
    // phase), then the destination attaches (layout phase).
    reg.slotRef('chat')(null);
    reg.slotRef('chat')(centre);

    expect(reg.container('chat')).toBe(before);   // identity survived
    expect(made()).toBe(1);                       // nothing was rebuilt
    expect(right.kids).toEqual([]);
    expect(centre.kids).toEqual([before]);
  });

  it('is idempotent: re-running the ref on the same slot does not reparent', () => {
    const { reg } = registry();
    const slot = node();
    const c = reg.container('chat');
    reg.slotRef('chat')(slot);
    c.scrollTop = 120;
    reg.slotRef('chat')(slot);   // a gossip push re-renders the zone
    reg.slotRef('chat')(slot);
    expect(slot.kids).toEqual([c]);
    expect(c.scrollTop).toBe(120);
  });

  it('adopts across DOCUMENTS — a dock ⇄ window move is the same one call', () => {
    const { reg, made } = registry();
    const docked = node('main');
    const detached = node('havvn-dock-1');
    reg.slotRef('chat')(docked);
    const c = reg.container('chat');
    reg.slotRef('chat')(null);
    reg.slotRef('chat')(detached);
    expect(reg.container('chat')).toBe(c);
    expect(made()).toBe(1);
    expect(detached.kids).toEqual([c]);
  });
});

describe('a null claim never destroys or recreates', () => {
  it('leaves the container mounted-but-PARKED when its zone stops rendering', () => {
    // This is a feature, not a hole: a panel whose zone is not rendered (the stage
    // overlay is up, the tear-off window has not opened yet) keeps running and is
    // adopted the instant a slot appears.
    const { reg, made } = registry();
    const slot = node();
    reg.slotRef('voice')(slot);
    const c = reg.container('voice');
    reg.slotRef('voice')(null);
    expect(reg.slotOf('voice')).toBeNull();
    expect(reg.container('voice')).toBe(c);
    expect(made()).toBe(1);

    const later = node();
    reg.slotRef('voice')(later);
    expect(later.kids).toEqual([c]);
  });
});

describe('scroll survives the reparent', () => {
  it('restores the container subtree offsets around the appendChild', () => {
    const { reg } = registry();
    const c = reg.container('chat') as FakeNode;
    const inner = node();
    c.appendChild(inner);
    // The registry only walks descendants when the node can be queried.
    (c as unknown as { querySelectorAll: (s: string) => FakeNode[] }).querySelectorAll = () => [inner];

    const from = node();
    reg.slotRef('chat')(from);
    c.scrollTop = 40;
    inner.scrollTop = 900;
    inner.scrollLeft = 12;

    const to = node();
    // Reparenting in a real DOM zeroes these; the fake does not, so the assertion
    // is that the registry READ them and wrote them back (it must not blank them).
    reg.slotRef('chat')(null);
    reg.slotRef('chat')(to);

    expect(c.scrollTop).toBe(40);
    expect(inner.scrollTop).toBe(900);
    expect(inner.scrollLeft).toBe(12);
    expect(to.kids).toEqual([c]);
  });

  it('does not need querySelectorAll to exist', () => {
    const { reg } = registry();
    const slot = node();
    expect(() => reg.slotRef('chat')(slot)).not.toThrow();
  });
});

describe('release / retain', () => {
  it('detaches a dead panel container but keeps the node for reuse', () => {
    const { reg, made } = registry();
    const slot = node();
    reg.slotRef('chat')(slot);
    const c = reg.container('chat');
    reg.release('chat');
    expect(slot.kids).toEqual([]);
    expect(reg.slotOf('chat')).toBeNull();
    expect(reg.container('chat')).toBe(c);
    expect(made()).toBe(1);
  });

  it('is idempotent, so a repeated diff cannot throw', () => {
    const { reg } = registry();
    reg.container('chat');
    expect(() => { reg.release('chat'); reg.release('chat'); }).not.toThrow();
  });

  it('retain releases exactly the panels that left the live set', () => {
    const { reg } = registry();
    const a = node();
    const b = node();
    reg.slotRef('chat')(a);
    reg.slotRef('voice')(b);
    reg.retain(['chat']);
    expect(a.kids).toHaveLength(1);
    expect(b.kids).toHaveLength(0);
  });
});
