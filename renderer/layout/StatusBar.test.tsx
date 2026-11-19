import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// StatusBar consumes the i18n context; render-state tests don't need real locale
// loading, so t() just echoes the key (same pattern as Sidebar.test).
vi.mock('../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { StatusBar } from './StatusBar';

// contextBridge freezes window.api in the real app, so the presence pipeline
// can't be stubbed from devtools — the chip's render states are pinned here.
describe('StatusBar presence bridge', () => {
  it('renders no presence chip when roomPresence is null', () => {
    const html = renderToStaticMarkup(<StatusBar roomPresence={null} />);
    expect(html).not.toContain('status-presence');
    expect(html).toContain('statusbar.service.loading');
    expect(html).not.toContain('statusbar.connected');
  });

  it('shows the room name and friends-online count', () => {
    const html = renderToStaticMarkup(
      <StatusBar roomPresence={{ roomId: 'r1', name: 'Movie Night', othersOnline: 3, watching: false }} />,
    );
    expect(html).toContain('status-presence');
    expect(html).toContain('Movie Night');
    expect(html).toContain('3 rooms.rail.online');
    expect(html).toContain('rooms.join');
  });

  it('watching together beats the online count in the label', () => {
    const html = renderToStaticMarkup(
      <StatusBar roomPresence={{ roomId: 'r1', name: 'Movie Night', othersOnline: 2, watching: true }} />,
    );
    expect(html).toContain('statusbar.watchingTogether');
    expect(html).not.toContain('2 rooms.rail.online');
  });
});
