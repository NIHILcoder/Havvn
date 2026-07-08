import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Sidebar consumes the i18n context; render-state tests don't need real locale
// loading, so t() just echoes the key.
vi.mock('../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { Sidebar } from './Sidebar';

const base = {
  onNavigate: () => {},
  filterMode: 'all' as const,
  onFilterChange: () => {},
  downloadCounts: { all: 5, downloading: 2, completed: 3, paused: 0, error: 0 },
  activeDownloads: 2,
};

describe('Sidebar two-pillar navigation', () => {
  it('downloads page → transfers pillar active, filter list shown, no rooms context', () => {
    const html = renderToStaticMarkup(<Sidebar {...base} currentPage="downloads" />);
    expect(html).toContain('pillar-switch');
    // first pillar button carries .on
    expect(html).toMatch(/pillar-btn on[^>]*>.*?nav\.downloads/s);
    expect(html).toContain('filter.downloading');
    expect(html).not.toContain('room-nav-item');
    expect(html).not.toContain('rooms.emptyDesc');
  });

  it('rooms page → rooms pillar active with the room list and a live dot', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        {...base}
        currentPage="rooms"
        rooms={[
          { roomId: 'r1', name: 'Movie Night', code: '', folder: '', memberCount: 4, onlineCount: 3, fileCount: 2, createdAt: 1 },
          { roomId: 'r2', name: 'The Archive', code: '', folder: '', memberCount: 12, onlineCount: 1, fileCount: 40, createdAt: 2 },
        ]}
      />,
    );
    expect(html).toMatch(/pillar-btn on[^>]*>.*?nav\.rooms/s);
    expect(html).toContain('Movie Night');
    expect(html).toContain('2 online');            // onlineCount-1 (self excluded)
    expect(html).toContain('room-nav-live');       // live dot only for r1
    expect(html).toContain('12 members');          // quiet room shows members
    expect(html).not.toContain('filter.downloading');
  });

  it('rooms pillar with no rooms shows the empty hint; online people render when present', () => {
    const empty = renderToStaticMarkup(<Sidebar {...base} currentPage="rooms" rooms={[]} />);
    expect(empty).toContain('rooms.emptyDesc');

    const withPeople = renderToStaticMarkup(
      <Sidebar
        {...base}
        currentPage="rooms"
        rooms={[{ roomId: 'r1', name: 'Movie Night', code: '', folder: '', memberCount: 2, onlineCount: 2, fileCount: 0, createdAt: 1 }]}
        onlinePeople={[{ memberId: 'm1', name: 'Mara', avatarSeed: 'm1', roomName: 'Movie Night' }]}
      />,
    );
    expect(withPeople).toContain('Online now');
    expect(withPeople).toContain('Mara');
  });

  it('utility pages keep the transfers context and mark their footer icon active', () => {
    const html = renderToStaticMarkup(<Sidebar {...base} currentPage="settings" />);
    expect(html).toMatch(/pillar-btn on[^>]*>.*?nav\.downloads/s); // pillar stays transfers
    expect(html).toContain('filter.all');                          // contextual list intact
    expect(html).toMatch(/sidebar-util-btn active[^>]*aria-label="nav\.settings"/);
  });
});
