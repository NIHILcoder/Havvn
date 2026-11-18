/**
 * Settings → System section (new card-based layout).
 *
 * Ports renderSystemSettings() from the old SettingsPage monolith: the
 * default-client row, check-for-updates / restart-and-install row, clear
 * cache, and export/import settings — reading everything from useSettings()
 * and rendered on the shared SettingsCard/SettingRow primitives.
 */

import React, { useState } from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, StatusPill } from '../controls';
import { Button, Icon, Select } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { TRANSFER_SECTIONS } from '../../../../shared/interface-preferences';
import { OperationStatus } from '../../../components/OperationStatus';
import type { ResourceMode } from '../../../../shared/resource-mode';
import { resourceMode, useResourceMode } from '../../../utils/resource-mode';
import '../ResourceModePanel.css';
import { StorageOverviewBody, useStorageOverview } from '../StorageOverview';
import { useHostWindow } from '../../../utils/hostWindow';

// Keep the labelled controls in this section so both build and live search index them.
export const ResourceModePanel: React.FC = () => {
  const { t } = useTranslation();
  const { snapshot, status } = useResourceMode();
  const [saving, setSaving] = useState(false), [error, setError] = useState(false);
  const select = async (mode: ResourceMode) => {
    setSaving(true); setError(false);
    try { resourceMode.receive(await window.api.resourceMode.set(mode)); }
    catch { setError(true); await resourceMode.refresh(); }
    finally { setSaving(false); }
  };
  return <SettingsCard title={t('resources.title')} description={t('resources.description')}>
    <SettingRow wide label={t('resources.mode')} description={t('resources.modeDescription')} control={<Select
      ariaLabel={t('resources.mode')} value={snapshot.mode} disabled={saving || status !== 'ready'}
      onChange={value => { void select(value as ResourceMode); }} options={[
        { value: 'normal', label: t('resources.normal') }, { value: 'economy', label: t('resources.economy') }, { value: 'auto', label: t('resources.auto') },
      ]} />} />
    <div className="resources-status">
      {status === 'ready' && <>
        <p>{t('resources.current')}: <strong>{snapshot.economy ? t('resources.economy') : t('resources.normal')}</strong></p>
        <p>{t('resources.source')}: {snapshot.source === 'manual' ? t('resources.manual') : snapshot.power === 'battery' ? t('resources.battery') : snapshot.power === 'ac' ? t('resources.ac') : t('resources.unknown')}</p>
        {snapshot.mode === 'auto' && snapshot.power === 'unknown' && <p>{t('resources.autoUnknown')}</p>}
        {snapshot.economy && <ul><li>{t('resources.effects')}</li><li>{t('resources.stats')}</li><li>{t('resources.previews')}</li><li>{t('resources.prefetchPaused')}</li></ul>}
        <p>{t('resources.preserved')}</p>
      </>}
      {status !== 'ready' && <p role="status">{status === 'loading' ? t('resources.loading') : t('resources.unavailable')}</p>}
      {error && <p role="alert">{t('resources.saveError')}</p>}
    </div>
  </SettingsCard>;
};

export const StorageOverviewPanel: React.FC = () => {
  const { t } = useTranslation(), host = useHostWindow(), model = useStorageOverview();
  return <SettingsCard title={t('storage.title')} description={t('storage.description')} icon="hard-drive">
    <SettingRow label={t('storage.scan')} description={t('storage.scanDescription')} stack control={<div className="storage-scan-controls">
      <Button variant="secondary" data-storage-start disabled={model.busy} onClick={() => { void model.start(); }}>{t(model.report ? 'storage.refresh' : 'storage.start')}</Button>
      {model.busy && <Button variant="ghost" data-storage-cancel disabled={model.canceling} onClick={() => { void model.cancel(); }}>{t(model.canceling ? 'storage.canceling' : 'storage.cancel')}</Button>}
    </div>} />
    <StorageOverviewBody model={model} onCache={() => {
      const control = host.document.querySelector<HTMLButtonElement>('[data-storage-cache-control]');
      control?.scrollIntoView({ block: 'center' }); control?.focus({ preventScroll: true });
    }} />
  </SettingsCard>;
};

export const SystemSection: React.FC = () => {
  const { t } = useTranslation();
  const {
    isDefaultClient, handleSetDefaultClient,
    updateReady, handleCheckForUpdates,
    handleClearCache, clearingCache,
    handleExportSettings, handleImportSettings,
    selectedTransferSections, setSelectedTransferSections, transferBusy, transferStatus, handleRestoreSettings, handleRecoverSettings, exportObservation,
    settings, setSettings,
  } = useSettings();

  const updateChannel = settings?.updateChannel ?? 'stable';

  // Instant-apply, optimistic — mirrors selectDohTemplate in SettingsContext.
  const selectUpdateChannel = async (next: 'stable' | 'beta') => {
    if (next === updateChannel) return;
    setSettings(prev => (prev ? { ...prev, updateChannel: next } : prev));
    try { await window.api.updateSettings({ updateChannel: next }); }
    catch (err) { console.error('Failed to set update channel:', err); }
  };

  return (
    <>
      <ResourceModePanel />
      <StorageOverviewPanel />
      <SettingsCard title={t('settings.grp.backup')} icon="archive">
        {exportObservation.operation && <OperationStatus operation={exportObservation.operation} />}
        {exportObservation.unavailable && <p role="status">{t('operation.observationUnavailable')}</p>}
        <fieldset className="stg-transfer-sections" data-setting-label={t('settings.transfer.sections')} disabled={transferBusy}>
          <legend>{t('settings.transfer.sections')}</legend>
          <div className="stg-transfer-section-options">
            {TRANSFER_SECTIONS.map(section => <label key={section}>
              <input type="checkbox" checked={selectedTransferSections.includes(section)} onChange={event => {
                const checked = event.currentTarget.checked;
                setSelectedTransferSections(current => checked ? [...current, section] : current.filter(value => value !== section));
              }} />
              {t(`settings.transfer.section.${section}`)}
            </label>)}
          </div>
        </fieldset>
        <SettingRow
          label={t('settings.exportSettings')}
          description={t('settings.exportSettings.desc')}
          control={
            <Button variant="secondary" disabled={transferBusy || !selectedTransferSections.length || transferStatus.recoveryNeeded} onClick={handleExportSettings}>
              {t('settings.export')}
            </Button>
          }
        />
        <SettingRow
          label={t('settings.importSettings')}
          description={t('settings.importSettings.desc')}
          control={
            <Button variant="secondary" disabled={transferBusy || !selectedTransferSections.length || transferStatus.recoveryNeeded} onClick={handleImportSettings}>
              {t('settings.import')}
            </Button>
          }
        />
        <SettingRow label={t('settings.transfer.restore')} description={t('settings.transfer.restoreDesc')}
          control={<Button variant="secondary" disabled={transferBusy || !selectedTransferSections.length || !transferStatus.backupAt || transferStatus.recoveryNeeded} onClick={handleRestoreSettings}>{t('settings.transfer.restore')}</Button>} />
        {transferStatus.recoveryNeeded && <SettingRow label={t('settings.transfer.recoveryTitle')} description={t('settings.transfer.recoveryDesc')}
          control={<Button variant="secondary" disabled={transferBusy} onClick={handleRecoverSettings}>{t('settings.transfer.recover')}</Button>} />}
      </SettingsCard>

      <SettingsCard title={t('settings.grp.osIntegration')} icon="monitor">
        <SettingRow
          label={t('settings.defaultClient')}
          description={t('settings.defaultClient.desc')}
          control={
            isDefaultClient ? (
              <StatusPill tone="ok">
                <Icon name="check-circle" size={14} />
                {t('settings.currentDefault')}
              </StatusPill>
            ) : (
              <Button variant="secondary" onClick={handleSetDefaultClient}>
                {t('settings.setDefault')}
              </Button>
            )
          }
        />
      </SettingsCard>

      <SettingsCard title={t('settings.grp.updates')} icon="refresh-cw">
        <SettingRow
          label={t('settings.updateChannel')}
          description={t('settings.updateChannel.desc')}
          control={
            <div style={{ width: 150 }}>
              <Select
                options={[
                  { value: 'stable', label: t('settings.updateChannel.stable') },
                  { value: 'beta', label: t('settings.updateChannel.beta') },
                ]}
                value={updateChannel}
                onChange={(v) => selectUpdateChannel(v as 'stable' | 'beta')}
              />
            </div>
          }
        />
        <SettingRow
          label={updateReady ? t('settings.updateReady') : t('settings.checkUpdates')}
          description={
            updateReady
              ? `${t('settings.versionWord')} ${updateReady} ${t('settings.downloadedRestart')}`
              : t('settings.checkUpdatesDesc')
          }
          control={
            updateReady ? (
              <Button
                variant="primary"
                icon={<Icon name="refresh" size={16} />}
                onClick={() => window.api.quitAndInstallUpdate()}
              >
                {t('settings.restartInstall')}
              </Button>
            ) : (
              <Button variant="secondary" onClick={handleCheckForUpdates}>
                {t('settings.checkNow')}
              </Button>
            )
          }
        />
      </SettingsCard>

      <SettingsCard title={t('settings.grp.maintenance')} icon="database">
        <SettingRow
          label={t('settings.clearCache')}
          description={t('settings.clearCache.desc')}
          control={
            <Button
              variant="secondary"
              icon={<Icon name="trash" size={16} />}
              onClick={handleClearCache}
              data-storage-cache-control
              loading={clearingCache}
              disabled={clearingCache}
            >
              {t('settings.clear')}
            </Button>
          }
        />
      </SettingsCard>
    </>
  );
};
