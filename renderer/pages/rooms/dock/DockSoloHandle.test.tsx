import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockSoloHandle } from './DockSoloHandle';
import type { DockStripInteractions } from './DockTabStrip';

// Like the rest of this folder, the handle takes already-translated strings, so
// there is no i18n context to mock.
const DOCK: DockStripInteractions = {
  zoneId: 'centre',
  windowKey: 'main',
  moveTargets: () => [
    { zone: 'left', label: 'Left' },
    { zone: 'centre', label: 'Centre', current: true },
  ],
  actions: () => [{ key: 'new-window', label: 'Open in new window', onSelect: () => {} }],
  onMovePanel: () => {},
  labels: { moveTo: 'Move to', tabMenu: 'Panel actions' },
};

const render = () => renderToStaticMarkup(
  <DockSoloHandle panelId="files" dock={DOCK} label="Move this panel" />,
);

describe('DockSoloHandle markup', () => {
  it('is a real, named button — the strip-less zone loses its only affordance otherwise', () => {
    const html = render();
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-label="Move this panel"');
    expect(html).toContain('title="Move this panel"');
    expect(html).toContain('class="dock-solo-handle"');
  });

  it('is BOTH a drag source and a menu trigger', () => {
    // A zone body is only ever a drop TARGET, so without both of these a solo panel
    // could be moved in and never out.
    const html = render();
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-dock-tab="files"');
  });

  it('keeps the grip glyph decorative — the button carries the name', () => {
    expect(render()).toMatch(/<span class="dock-solo-grip" aria-hidden="true">/);
  });

  it('renders no menu until one is opened (nothing portals during a static render)', () => {
    const html = render();
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('aria-expanded');
  });

  it('mounts with no DOM at all', () => {
    // Same discipline as the rest of the folder: nothing may dereference a global
    // at render time, or importing this file would take the whole suite down.
    expect(() => render()).not.toThrow();
  });
});
