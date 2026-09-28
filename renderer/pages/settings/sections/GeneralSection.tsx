/**
 * General settings — download-engine picker and application behavior toggles.
 * Ported from SettingsPage.renderGeneralSettings(); the engine-select widget
 * keeps its original markup (styles live in SettingsPage.css).
 */
import React from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, RestartPendingNotice } from '../controls';
import { Icon, Toggle } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { ExternalPlayerSessions } from '../../../components/ExternalPlayerSessions';
import { ExternalPlayerPreferences } from '../../../components/ExternalPlayerPreferences';

export const GeneralSection: React.FC = () => {
  const ctx = useSettings();
  const { t } = useTranslation();

  return (
    <>
      <SettingsCard title={t('settings.engine.title')} icon="cpu">
        {/* Toggle buttons (not ARIA radios — those would owe arrow-key nav);
            both options stay in the regular tab order. */}
        <div className="engine-select" role="group" aria-label={t('settings.engine.title')}>
          <button
            type="button"
            className={`engine-opt ${ctx.engine === 'native' ? 'on' : ''}`}
            aria-pressed={ctx.engine === 'native'}
            onClick={() => ctx.selectEngine('native')}
          >
            <span className="engine-opt-radio" aria-hidden="true" />
            <span className="engine-opt-title">
              Havvn {t('settings.engine.nativeWord')} <span className="engine-badge">{t('settings.engine.nativeBadge')}</span>
            </span>
            <span className="engine-opt-desc">{t('settings.engine.nativeDesc')}</span>
          </button>
          <button
            type="button"
            className={`engine-opt ${ctx.engine === 'webtorrent' ? 'on' : ''}`}
            aria-pressed={ctx.engine === 'webtorrent'}
            onClick={() => ctx.selectEngine('webtorrent')}
          >
            <span className="engine-opt-radio" aria-hidden="true" />
            <span className="engine-opt-title">{t('settings.engine.classic')}</span>
            <span className="engine-opt-desc">{t('settings.engine.classicDesc')}</span>
          </button>
        </div>
        {ctx.engineRestartPending ? (
          <RestartPendingNotice text={t('settings.engine.pending')} />
        ) : (
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.engine.restartNote')}</span>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title={t('external.player')} icon="monitor">
        <ExternalPlayerPreferences /><ExternalPlayerSessions />
      </SettingsCard>
      <SettingsCard title={t('settings.grp.application')} icon="power">
        <SettingRow
          label={t('settings.autoLaunch')}
          description={t('settings.autoLaunch.desc')}
          control={
            <Toggle
              checked={ctx.autoLaunch}
              onChange={(v) =>
                ctx.applyToggle(v, ctx.setAutoLaunch, { autoLaunch: v }, (val) => window.api.setAutoLaunch(val))
              }
            />
          }
        />
        <SettingRow
          label={t('settings.autoUpdate')}
          description={t('settings.autoUpdate.desc')}
          control={
            <Toggle
              checked={ctx.autoUpdate}
              onChange={(v) => ctx.applyToggle(v, ctx.setAutoUpdate, { autoUpdate: v })}
            />
          }
        />
      </SettingsCard>

      <SettingsCard title={t('settings.grp.behavior')} icon="minimize">
        <SettingRow
          label={t('settings.minTray')}
          description={t('settings.minTray.desc')}
          control={
            <Toggle
              checked={ctx.minimizeToTray}
              onChange={(v) =>
                ctx.applyToggle(v, ctx.setMinimizeToTray, { minimizeToTray: v }, (val) => window.api.setMinimizeToTray(val))
              }
            />
          }
        />
        <SettingRow
          label={t('settings.closeTray')}
          description={t('settings.closeTray.desc')}
          control={
            <Toggle
              checked={ctx.closeToTray}
              onChange={(v) =>
                ctx.applyToggle(v, ctx.setCloseToTray, { closeToTray: v }, (val) => window.api.setCloseToTray(val))
              }
            />
          }
        />
      </SettingsCard>
    </>
  );
};
