/**
 * Which tabs a server instance has, and what happens to the user's choice when
 * they switch to an instance that does not have it.
 *
 * `tab` is held above the selection so it survives switching instances — which
 * is what makes the fallback necessary rather than theoretical: every panel in
 * the body is gated on the same conditions that built the tab list, so a stale
 * tab renders a strip with nothing active above an empty box.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { resolveTab, visibleTabsFor, type Tab } from './RoomServerPanel';

describe('visibleTabsFor', () => {
  it('gives a local Minecraft server everything', () => {
    expect(visibleTabsFor({ moduleId: 'minecraft' })).toEqual([
      'overview', 'console', 'content', 'schedule', 'access', 'backup', 'players', 'settings',
    ]);
  });

  it('withholds the player lists from a non-Minecraft server', () => {
    const tabs = visibleTabsFor({ moduleId: 'generic' });
    expect(tabs).not.toContain('players');
    expect(tabs).toContain('settings');
  });

  it('gives a remote instance only what a mirror can answer', () => {
    // No local directory to configure, no schedule to arm, nobody here to grant.
    expect(visibleTabsFor({ remote: true, moduleId: 'minecraft' })).toEqual(['overview', 'console']);
  });

  it('always offers Overview, whatever the instance is', () => {
    for (const instance of [
      { moduleId: 'minecraft' }, { moduleId: 'generic' },
      { remote: true, moduleId: 'minecraft' }, { remote: false, moduleId: '' },
    ]) {
      expect(visibleTabsFor(instance)).toContain('overview');
    }
  });
});

describe('resolveTab', () => {
  it('keeps a tab the instance has', () => {
    const tabs = visibleTabsFor({ moduleId: 'minecraft' });
    for (const tab of tabs) expect(resolveTab(tab, tabs)).toBe(tab);
  });

  it('falls back to Overview when the tab is gone', () => {
    // Backup → a remote instance: the old behaviour left `tab` on 'backup',
    // which the remote strip does not list and the remote body does not render.
    const remote = visibleTabsFor({ remote: true, moduleId: 'minecraft' });
    expect(resolveTab('backup', remote)).toBe('overview');
    expect(resolveTab('settings', remote)).toBe('overview');
    expect(resolveTab('console', remote)).toBe('console');
  });

  it('drops Players when moving off a Minecraft server', () => {
    const generic = visibleTabsFor({ moduleId: 'generic' });
    expect(resolveTab('players', generic)).toBe('overview');
    expect(resolveTab('backup', generic)).toBe('backup');
  });

  it('resolves to a tab that is always in the list', () => {
    const every: Tab[] = ['overview', 'console', 'content', 'schedule', 'access', 'backup', 'players', 'settings'];
    for (const instance of [{ moduleId: 'minecraft' }, { moduleId: 'generic' }, { remote: true, moduleId: 'x' }]) {
      const tabs = visibleTabsFor(instance);
      for (const tab of every) expect(tabs).toContain(resolveTab(tab, tabs));
    }
  });
});
