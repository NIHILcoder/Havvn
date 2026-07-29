import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WindowControls, DEFAULT_WINDOW_CONTROL_LABELS, IS_MAC } from './WindowControls';

// renderToStaticMarkup, no jsdom: this component exists precisely so the SECOND
// frameless window in the app (a torn-off dock group) can render the app's
// controls from a harness that has neither a DOM nor a preload bridge.

const labels = { minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore', close: 'Close' };

const render = (extra: Partial<React.ComponentProps<typeof WindowControls>> = {}) =>
  renderToStaticMarkup(
    <WindowControls
      maximized={false}
      labels={labels}
      onMinimize={() => {}}
      onToggleMaximize={() => {}}
      onClose={() => {}}
      {...extra}
    />,
  );

describe('WindowControls', () => {
  // The whole suite is about the non-mac chrome; on a mac host the component is
  // correctly empty (hiddenInset keeps the native traffic lights).
  it.runIf(!IS_MAC)('draws the three app control buttons, in the app\'s own classes', () => {
    const html = render();
    // `.titlebar-controls` / `.tb-ctrl` / `.tb-close` are defined once in
    // layout.css. Rendering anything else here is how the two bars drift apart.
    expect(html).toContain('class="titlebar-controls"');
    expect(html.match(/class="tb-ctrl"/g)).toHaveLength(2);
    expect(html).toContain('class="tb-ctrl tb-close"');
    expect(html.match(/<button /g)).toHaveLength(3);
  });

  it.runIf(!IS_MAC)('names every control for a screen reader', () => {
    const html = render();
    for (const name of ['Minimize', 'Maximize', 'Close']) {
      expect(html).toContain(`aria-label="${name}"`);
      expect(html).toContain(`title="${name}"`);
    }
    // The glyphs are decoration; the button carries the name.
    expect(html).not.toContain('aria-label=""');
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
  });

  it.runIf(!IS_MAC)('says RESTORE, not maximize, once the window is maximized', () => {
    // Label and glyph must flip together — an unchanged name on a changed icon is
    // the version of this bug a sighted user never sees.
    const html = render({ maximized: true });
    expect(html).toContain('aria-label="Restore"');
    expect(html).not.toContain('aria-label="Maximize"');
    expect(html).toContain('d="M3.5 3.5V1.5h6v6h-2"'); // the restore glyph
  });

  it.runIf(!IS_MAC)('falls back to English rather than announcing a nameless button', () => {
    // A caller with no dictionary in reach (a bar wired before its labels are)
    // must still ship controls that are announced, not three unnamed buttons.
    const html = render({ labels: undefined });
    expect(html).toContain(`aria-label="${DEFAULT_WINDOW_CONTROL_LABELS.minimize}"`);
    expect(html).toContain(`aria-label="${DEFAULT_WINDOW_CONTROL_LABELS.close}"`);
  });

  it('renders with no DOM and no preload bridge at all', () => {
    // Nothing here may dereference a global at render time — the dock's node
    // harness imports this file transitively, and a throw would take the whole
    // suite down on import.
    expect(() => render()).not.toThrow();
  });
});
