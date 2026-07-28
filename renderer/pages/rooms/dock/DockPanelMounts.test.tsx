import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DockPanelMounts } from './DockPanelMounts';
import { createDockMountRegistry } from './dockMountRegistry';
import { resolveLiveMounts } from './dockMounts';

type Id = 'voice' | 'files' | 'chat';

const registry = () => createDockMountRegistry<Id>({
  // Never reached in this harness: with no `document`, DockPanelMounts renders null
  // before it asks for a single container.
  createElement: () => { throw new Error('containers must not be built without a DOM'); },
});

const live = resolveLiveMounts(
  [
    { zoneId: 'left', panels: ['voice'] as Id[], active: 'voice' as Id },
    { zoneId: 'w1', panels: ['chat'] as Id[], active: 'chat' as Id },
  ],
  () => false,
  ['voice', 'files', 'chat'] as Id[],
);

// The interesting behaviour — portalling into a stable container, and the realm
// wrappers — needs a real DOM and cannot be exercised here (renderer tests are
// renderToStaticMarkup with no jsdom, and createPortal throws under the server
// renderer). What CAN be pinned is the property the whole room depends on: this
// component is inert and DOM-free when there is nothing to portal into, so every
// existing renderToStaticMarkup test of the room keeps working.
describe('DockPanelMounts with no DOM', () => {
  it('renders nothing at all rather than reaching for a container', () => {
    const renderPanel = vi.fn(() => <div>body</div>);
    const html = renderToStaticMarkup(
      <DockPanelMounts<Id>
        live={live}
        registry={registry()}
        renderPanel={renderPanel}
        realmOf={() => null}
        toasterIdOf={() => undefined}
      />,
    );
    expect(html).toBe('');
    // ...and it did not even build the panel bodies, let alone their containers.
    expect(renderPanel).not.toHaveBeenCalled();
  });

  it('is inert for an empty live set too', () => {
    expect(renderToStaticMarkup(
      <DockPanelMounts<Id>
        live={[]}
        registry={registry()}
        renderPanel={() => <div>body</div>}
        realmOf={() => null}
        toasterIdOf={() => undefined}
      />,
    )).toBe('');
  });
});
