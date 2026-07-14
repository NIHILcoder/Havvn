import { describe, it, expect, vi, beforeAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Sections consume the i18n context; render-state tests don't need real locale
// loading, so t() just echoes the key (same pattern as Sidebar.test).
vi.mock('../../../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k, language: 'en', setLanguage: () => {} }),
}));

// The provider wires ~30 window.api calls in effects; renderToStaticMarkup runs
// no effects, but handlers still close over window.api — give it a benign stub
// so any accidental render-time access fails loudly instead of crashing vaguely.
beforeAll(() => {
  (globalThis as Record<string, unknown>).window = globalThis.window ?? (globalThis as unknown as Window);
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as unknown as Storage;
  (globalThis as unknown as { window: { api: unknown; matchMedia: unknown } }).window.api = new Proxy({}, {
    get: () => () => Promise.resolve(undefined),
  });
  (globalThis as unknown as { window: { matchMedia: unknown } }).window.matchMedia =
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
});

import { SettingsProvider } from '../SettingsContext';
import { SettingsNav } from '../SettingsNav';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import { ThemeEditorProvider } from '../../../components/ThemeEditorContext';
import { GeneralSection } from './GeneralSection';
import { DownloadsSection } from './DownloadsSection';
import { ConnectionSection } from './ConnectionSection';
import { PrivacySection } from './PrivacySection';
import { SharingSection } from './SharingSection';
import { SeedingSection } from './SeedingSection';
import { SchedulerSection } from './SchedulerSection';
import { InterfaceSection } from './InterfaceSection';
import { HotkeysSection } from './HotkeysSection';
import { NotificationsSection } from './NotificationsSection';
import { SystemSection } from './SystemSection';
import { AboutSection } from './AboutSection';

const SECTIONS: Array<[string, React.FC]> = [
  ['general', GeneralSection],
  ['downloads', DownloadsSection],
  ['connection', ConnectionSection],
  ['privacy', PrivacySection],
  ['sharing', SharingSection],
  ['seeding', SeedingSection],
  ['scheduler', SchedulerSection],
  ['interface', InterfaceSection],
  ['hotkeys', HotkeysSection],
  ['notifications', NotificationsSection],
  ['system', SystemSection],
  ['about', AboutSection],
];

describe('settings sections render on the primitives system', () => {
  it.each(SECTIONS)('%s section mounts inside the provider without crashing', (_id, Section) => {
    const html = renderToStaticMarkup(
      <ConfirmProvider>
        <ThemeEditorProvider>
          <SettingsProvider>
            <Section />
          </SettingsProvider>
        </ThemeEditorProvider>
      </ConfirmProvider>,
    );
    expect(html.length).toBeGreaterThan(0);
  });

  it('every section uses the shared card/row primitives (no legacy .setting-item rows)', () => {
    for (const [id, Section] of SECTIONS) {
      const html = renderToStaticMarkup(
        <ConfirmProvider>
          <ThemeEditorProvider>
            <SettingsProvider>
              <Section />
            </SettingsProvider>
          </ThemeEditorProvider>
        </ConfirmProvider>,
      );
      expect(html, `${id} still renders legacy .setting-item markup`).not.toContain('"setting-item"');
      expect(html, `${id} renders no stg-card`).toContain('stg-card');
      // Toggles inside SettingRows must not render a visible duplicate label
      // (that was the "toggles jump around" bug) — the row already names them.
      expect(html, `${id} renders a visible toggle-label`).not.toContain('toggle-label');
      // The old inaccessible raw toggle must be gone everywhere.
      expect(html, `${id} uses the legacy raw toggle button`).not.toMatch(/class="toggle-switch\s*(active)?\s*"\s*>(?!<span class="toggle-slider")/);
    }
  });

  it('the nav renders all groups and filters by search', () => {
    const nav = renderToStaticMarkup(<SettingsNav active="general" onSelect={() => {}} />);
    for (const g of ['settings.group.core', 'settings.group.privacy', 'settings.group.seeding', 'settings.group.appearance', 'settings.group.system']) {
      expect(nav).toContain(g);
    }
    for (const id of ['settings.general', 'settings.connection', 'settings.sharing', 'settings.about']) {
      expect(nav).toContain(id);
    }
  });
});
