import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBar } from './StatusBar';

// contextBridge freezes window.api in the real app, so the presence pipeline
// can't be stubbed from devtools — the chip's render states are pinned here.
describe('StatusBar presence bridge', () => {
  it('renders no presence chip when roomPresence is null', () => {
    const html = renderToStaticMarkup(<StatusBar roomPresence={null} />);
    expect(html).not.toContain('status-presence');
    expect(html).toContain('Connected'); // the rest of the bar is intact
  });

  it('shows the room name and friends-online count', () => {
    const html = renderToStaticMarkup(
      <StatusBar roomPresence={{ roomId: 'r1', name: 'Movie Night', othersOnline: 3, watching: false }} />,
    );
    expect(html).toContain('status-presence');
    expect(html).toContain('Movie Night');
    expect(html).toContain('3 online');
    expect(html).toContain('Join');
  });

  it('watching together beats the online count in the label', () => {
    const html = renderToStaticMarkup(
      <StatusBar roomPresence={{ roomId: 'r1', name: 'Movie Night', othersOnline: 2, watching: true }} />,
    );
    expect(html).toContain('watching together');
    expect(html).not.toContain('2 online');
  });
});
