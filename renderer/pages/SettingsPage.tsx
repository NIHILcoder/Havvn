/**
 * Settings — the redesigned page shell.
 *
 * Thin by design: all state and save logic live in SettingsContext (one
 * provider, extracted verbatim from the old monolith); each tab is its own
 * component under ./settings/sections built from the shared primitives
 * (SettingsCard / SettingRow / …). The shell only wires the grouped nav with
 * search, the section header, the toast alert, and the sticky Save bar.
 */
import React from 'react';
import { Button, Icon, Alert } from '../components';
import { useTranslation } from '../utils/i18nContext';
import { SettingsProvider, useSettings } from './settings/SettingsContext';
import { SettingsNav } from './settings/SettingsNav';
import { GeneralSection } from './settings/sections/GeneralSection';
import { DownloadsSection } from './settings/sections/DownloadsSection';
import { ConnectionSection } from './settings/sections/ConnectionSection';
import { PrivacySection } from './settings/sections/PrivacySection';
import { SharingSection } from './settings/sections/SharingSection';
import { SeedingSection } from './settings/sections/SeedingSection';
import { SchedulerSection } from './settings/sections/SchedulerSection';
import { InterfaceSection } from './settings/sections/InterfaceSection';
import { HotkeysSection } from './settings/sections/HotkeysSection';
import { NotificationsSection } from './settings/sections/NotificationsSection';
import { SystemSection } from './settings/sections/SystemSection';
import { AboutSection } from './settings/sections/AboutSection';
import './SettingsPage.css';
import './settings/shell.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TKey = any;

const SECTIONS: Record<string, React.FC> = {
  general: GeneralSection,
  downloads: DownloadsSection,
  connection: ConnectionSection,
  privacy: PrivacySection,
  sharing: SharingSection,
  seeding: SeedingSection,
  scheduler: SchedulerSection,
  interface: InterfaceSection,
  hotkeys: HotkeysSection,
  notifications: NotificationsSection,
  system: SystemSection,
  about: AboutSection,
};

const SettingsShell: React.FC = () => {
  const { t } = useTranslation();
  const ctx = useSettings();
  const { activeCategory, setActiveCategory, loading, message, setMessage, hasChanges, saving, handleSave, handleReset } = ctx;

  if (loading) {
    return (
      <div className="settings-page settings-loading">
        <Icon name="loader" size={32} />
        <p>{t('settings.loading')}</p>
      </div>
    );
  }

  const Section = SECTIONS[activeCategory] ?? GeneralSection;

  return (
    <div className="stg-page">
      {message && (
        <div className="settings-alert">
          <Alert variant={message.type === 'success' ? 'success' : 'error'} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        </div>
      )}

      <SettingsNav active={activeCategory} onSelect={setActiveCategory} />

      <div className="stg-main">
        <header className="stg-head">
          <div>
            <h1>{t(`settings.${activeCategory}` as TKey)}</h1>
            <p className="stg-head-sub">{t(`settings.${activeCategory}.sub` as TKey)}</p>
          </div>
        </header>

        <div className="stg-scroll">
          <div className="stg-col">
            <Section />
          </div>
        </div>

        {hasChanges && (
          <div className="stg-save">
            <span className="stg-save-note">{t('settings.unsaved')}</span>
            <div className="stg-save-actions">
              <Button variant="secondary" onClick={handleReset}>{t('settings.cancel')}</Button>
              <Button onClick={handleSave} loading={saving} disabled={saving}>
                {t('settings.saveChanges')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SettingsPage: React.FC = () => (
  <SettingsProvider>
    <SettingsShell />
  </SettingsProvider>
);

export default SettingsPage;
