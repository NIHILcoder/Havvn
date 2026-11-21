/**
 * Settings — the redesigned page shell.
 *
 * Thin by design: all state and save logic live in SettingsContext (one
 * provider, extracted verbatim from the old monolith); each tab is its own
 * component under ./settings/sections built from the shared primitives
 * (SettingsCard / SettingRow / …). The shell only wires the grouped nav with
 * search, the section header, the toast alert, and the sticky Save bar.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon, Alert } from '../components';
import { useTranslation } from '../utils/i18nContext';
import { SettingsProvider, useSettings } from './settings/SettingsContext';
import { SettingsNav } from './settings/SettingsNav';
import { findSettingTarget, type SettingSearchEntry } from './settings/settingsSearch';
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
import { AutomationSection } from './settings/sections/AutomationSection';
import { DevicesSection } from './settings/sections/DevicesSection';
import './SettingsPage.css';
import './settings/shell.css';
import type { Command } from '../commands/registry';
import { useConfirm } from '../components/ConfirmDialog';
import { pageLeave } from '../state/page-leave';
import { SettingsChangeReview, useSettingChanges } from './settings/SettingChanges';
import { SettingsTasks } from './settings/SettingsTasks';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TKey = any;

const SECTIONS: Record<string, React.FC> = {
  devices: DevicesSection,
  automation: AutomationSection,
  general: GeneralSection,
  downloads: DownloadsSection,
  privacy: PrivacySection,
  sharing: SharingSection,
  seeding: SeedingSection,
  scheduler: SchedulerSection,
  hotkeys: HotkeysSection,
  notifications: NotificationsSection,
  system: SystemSection,
  about: AboutSection,
};

interface SettingsPageProps {
  getNavigationCommands?: () => readonly Command[];
  focusRequest?: { entry: SettingSearchEntry; requestId: number } | null;
  onFocusHandled?: () => void;
}

const SettingsShell: React.FC<SettingsPageProps> = ({ focusRequest, onFocusHandled, getNavigationCommands }) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const ctx = useSettings();
  const changes = useSettingChanges();
  const savingAny = ctx.saving || ctx.instantSaving > 0 || ctx.turnSaving || ctx.trackersSaving || ctx.schedulerSaving;
  const { activeCategory, setActiveCategory, loading, message, setMessage, hasChanges, saving, handleSave, handleReset } = ctx;
  const scrollPane = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ result: SettingSearchEntry } | null>(null);
  const unsaved = hasChanges || !!ctx.netDraft || !!ctx.settings && (
    ctx.turnUrl !== (ctx.settings.customTurnUrl ?? '') || ctx.turnUser !== (ctx.settings.customTurnUsername ?? '') ||
    ctx.turnCred !== (ctx.settings.customTurnCredential ?? '') || ctx.customTrackers !== (ctx.settings.customTrackers ?? ''));
  useEffect(() => pageLeave.register(async () => {
    if (savingAny) { setMessage({ type: 'error', text: t('navigation.waitWork') }); return false; }
    return !unsaved || await confirm({ title: t('settings.unsaved'), message: t('settings.leaveDraft'),
      confirmLabel: t('settings.discardAndLeave'), cancelLabel: t('settings.stayEditing') });
  }), [unsaved, savingAny, confirm, t, setMessage]);
  useEffect(() => {
    if (!focusRequest) return;
    setSearchTarget({ result: focusRequest.entry });
    setActiveCategory(focusRequest.entry.section);
    onFocusHandled?.();
  }, [focusRequest]);
  useLayoutEffect(() => {
    scrollPane.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeCategory]);
  useEffect(() => {
    const root = content.current;
    if (!root || !searchTarget || searchTarget.result.section !== activeCategory) return;
    const target = findSettingTarget(root, searchTarget.result, t);
    if (!target) return;
    for (let parent = target.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    }
    target.dataset.settingsSearchTarget = '';
    const previousTabIndex = target.getAttribute('tabindex');
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    const win = root.ownerDocument.defaultView;
    target.scrollIntoView({ block: 'center', behavior: win?.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return () => {
      delete target.dataset.settingsSearchTarget;
      if (previousTabIndex === null) target.removeAttribute('tabindex'); else target.setAttribute('tabindex', previousTabIndex);
    };
  }, [activeCategory, searchTarget, loading, t]);
  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.code === 'KeyS' || event.key.toLowerCase() === 's')) {
        event.preventDefault();
        if (hasChanges && !saving) void handleSave();
      }
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  }, [hasChanges, saving, handleSave]);

  if (loading) {
    return (
      <div className="settings-page settings-loading">
        <Icon name="loader" size={32} />
        <p>{t('settings.loading')}</p>
      </div>
    );
  }

  if (ctx.loadFailed) {
    return <div className="settings-page settings-loading" role="alert">
      <Icon name="alert-triangle" size={32} />
      <p>{t('settings.msg.loadFailed')}</p>
      <Button onClick={() => { void ctx.loadSettings(); }}>{t('common.retry')}</Button>
    </div>;
  }

  const Section = SECTIONS[activeCategory] ?? GeneralSection;
  const openSetting = (result: SettingSearchEntry) => {
    setSearchTarget({ result });
    setActiveCategory(result.section);
  };
  let section = <Section />;
  if (activeCategory === 'connection') section = <ConnectionSection onOpenSetting={openSetting} />;
  else if (activeCategory === 'interface') section = <InterfaceSection getCommands={getNavigationCommands} />;

  return (
    <div className="stg-page">
      {message && (
        <div className="settings-alert">
          <Alert variant={message.type === 'success' ? 'success' : 'error'} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        </div>
      )}

      <SettingsNav active={activeCategory} onSelect={id => { setSearchTarget(null); setActiveCategory(id); }}
        onSelectSetting={openSetting} />

      <div className="stg-main">
        <header className="stg-head">
          <div>
            <h1>{t(`settings.${activeCategory}` as TKey)}</h1>
            <p className="stg-head-sub">{t(`settings.${activeCategory}.sub` as TKey)}</p>
            <p className="stg-save-hint">{t('settings.saveHint')}</p>
            <div className="stg-save-state" role="status"><span>{t(savingAny ? 'settings.review.saving' : changes.length ? 'settings.review.pending' : 'settings.review.clean').replace('{count}', String(changes.length))}</span>{(ctx.engineRestartPending || ctx.proxyRestartPending || ctx.transportRestartPending) && <span>{t('settings.review.restart')}</span>}</div>
          </div>
        </header>
        <div className="stg-scroll" ref={scrollPane}>
          <div className="stg-col" ref={content}>
            {activeCategory === 'general' && ctx.settings && <SettingsTasks settings={ctx.settings} locked={savingAny || unsaved} onNavigate={setActiveCategory} />}
            <SettingsChangeReview changes={changes} disabled={savingAny} navigate={setActiveCategory} />
            {section}
          </div>
        </div>

        {hasChanges && (
          <div className="stg-save">
            <span className="stg-save-note">{t('settings.unsaved')}</span>
            <div className="stg-save-actions">
              <Button variant="secondary" onClick={handleReset} disabled={saving}>{t('settings.cancel')}</Button>
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

const SettingsPage: React.FC<SettingsPageProps> = props => (
  <SettingsProvider>
    <SettingsShell {...props} />
  </SettingsProvider>
);

export default SettingsPage;
