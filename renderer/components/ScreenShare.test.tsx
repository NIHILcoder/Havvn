import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { ScreenView } from './ScreenShare';

// ScreenSourcePicker portals, and react-dom/server throws on createPortal, so it
// is not reachable from this harness at all. ScreenView renders inline and IS —
// what it proves is that the component mounts with no DOM globals and no
// HostWindowProvider: every window read it makes (ownerDocument for the
// fullscreen toggle, the keydown target) happens inside an effect or a click
// handler, never during render. Hoisting any of them to render would throw here.
describe('ScreenView markup', () => {
  const render = () =>
    renderToStaticMarkup(
      <ScreenView roomId="r1" memberId="m1" title="Mara" onClose={() => {}} />,
    );

  it('renders the inline card with a stage and a video element', () => {
    const html = render();
    expect(html).toContain('class="ssv-card ssv-inline"');
    expect(html).toContain('class="ssv-stage"');
    expect(html).toContain('class="ssv-video"');
    expect(html).toContain('Mara');
  });

  it('offers fullscreen and close actions', () => {
    const html = render();
    expect(html).toContain('rooms.screen.fullscreen');
    expect(html).toContain('common.close');
  });

  it('touches no DOM globals during render and needs no HostWindowProvider', () => {
    expect(() => render()).not.toThrow();
  });
});
