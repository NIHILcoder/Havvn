import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockHiddenPanels } from './DockHiddenPanels';
import type { DockHiddenPanelItem } from './dockHidden';

// Like the rest of this folder, the section takes already-translated strings, so
// there is no i18n context to mock.
const ITEMS: DockHiddenPanelItem[] = [
  { id: 'voice', label: 'Voice', where: 'Left column', showLabel: 'Show Voice', icon: <svg /> },
  { id: 'chat', label: 'Chat', where: 'Right column', showLabel: 'Show Chat' },
];

const render = (props: Partial<React.ComponentProps<typeof DockHiddenPanels>> = {}) =>
  renderToStaticMarkup(
    <DockHiddenPanels
      items={ITEMS}
      title="Hidden panels"
      onShow={() => {}}
      showAllLabel="Show all"
      onShowAll={() => {}}
      {...props}
    />,
  );

describe('DockHiddenPanels markup', () => {
  it('renders NOTHING when nothing is hidden — the host mounts it unconditionally', () => {
    expect(render({ items: [] })).toBe('');
  });

  it('is a labelled group, so the buttons read as one thing', () => {
    const html = render();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="dock-hidden-title"');
    expect(html).toContain('id="dock-hidden-title"');
    expect(html).toContain('Hidden panels');
  });

  it('gives every hidden panel a real, named button', () => {
    const html = render();
    // Plain buttons in DOM order: inside somebody else"s popover each row must be
    // an ordinary Tab stop, exactly like the rows above and below it.
    expect(html).toContain('data-dock-hidden="voice"');
    expect(html).toContain('data-dock-hidden="chat"');
    expect(html).toContain('type="button"');
    // The visible text is the bare panel name; the accessible name says what
    // activating the row DOES.
    expect(html).toContain('aria-label="Show Voice"');
    expect(html).toContain('title="Show Chat"');
  });

  it('falls back to the panel name when no composed show-label is given', () => {
    const html = render({ items: [{ id: 'files', label: 'Shared files' }] });
    expect(html).toContain('aria-label="Shared files"');
  });

  it('names the destination so a restore into an off-screen column is not a mystery', () => {
    const html = render();
    expect(html).toContain('Left column');
    // Said once: the row"s aria-label already carries the action in full.
    expect(html).toContain('<span class="dock-hidden-where" aria-hidden="true">Left column</span>');
  });

  it('keeps the icon decorative — the button carries the name', () => {
    expect(render()).toContain('<span class="dock-hidden-icon" aria-hidden="true">');
  });

  it('offers "Show all" only above one hidden panel', () => {
    expect(render()).toContain('data-dock-hidden-all');
    expect(render({ items: [ITEMS[0]] })).not.toContain('data-dock-hidden-all');
  });

  it('drops "Show all" when the host wired no handler or no label for it', () => {
    expect(render({ onShowAll: undefined })).not.toContain('data-dock-hidden-all');
    expect(render({ showAllLabel: undefined })).not.toContain('data-dock-hidden-all');
  });

  it('wears the HOST surface"s row class when given one', () => {
    // Mounted in the room-settings popover the rows must BE .room-settings-item, or
    // they drift from "Copy code" / "Rename" / "Reset layout" around them.
    const html = render({ itemClassName: 'room-settings-item' });
    expect(html).toContain('class="room-settings-item dock-hidden-item"');
    expect(html).not.toContain('dock-hidden-btn');
  });

  it('falls back to a self-sufficient row look with no host class', () => {
    expect(render()).toContain('class="dock-hidden-btn dock-hidden-item"');
  });

  it('namespaces its heading so two sections could coexist', () => {
    const html = render({ idPrefix: 'popover-a' });
    expect(html).toContain('id="popover-a-title"');
    expect(html).toContain('aria-labelledby="popover-a-title"');
  });

  it('mounts with no DOM at all', () => {
    // Same discipline as the rest of the folder: nothing may dereference a global
    // at render time, or importing this file would take the whole suite down.
    expect(() => render()).not.toThrow();
  });
});
