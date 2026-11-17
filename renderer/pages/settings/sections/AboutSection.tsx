/**
 * Settings → About — the app's identity page, rebuilt on the stg system.
 *
 * Identity, version, engine, license and statistics. The source link goes
 * through target="_blank", which main.ts redirects to shell.openExternal.
 */
import React from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, StatusPill } from '../controls';
import { Icon, AppStatistics, LogoMark } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import Button from '../../../components/Button';
import { openFirstSteps } from '../../../utils/first-steps';

const GITHUB_URL = 'https://github.com/NIHILcoder/Havvn';

export const AboutSection: React.FC = () => {
  const { t } = useTranslation();
  const { appVersion, runningEngine, stats } = useSettings();

  return (
    <>
      {/* Identity — centered, calm, no card chrome fighting the shell header. */}
      <div className="abt-hero">
        <LogoMark size={52} />
        <h2 className="abt-name">
          Ha<b>vv</b>n
        </h2>
        <p className="abt-tagline">{t('settings.appDesc')}</p>
      </div>

      <SettingsCard title={t('settings.about.infoTitle')} icon="info">
        <SettingRow
          label={t('settings.about.version')}
          description={t('settings.about.versionDesc')}
          control={<span className="abt-value">v{appVersion || '—'}</span>}
        />
        <SettingRow
          label={t('settings.about.engine')}
          description={t('settings.about.engineDesc')}
          control={
            <StatusPill tone={runningEngine === 'webtorrent' ? 'muted' : 'ok'}>
              {runningEngine === 'webtorrent'
                ? t('settings.about.engineWebtorrent')
                : t('settings.about.engineNative')}
            </StatusPill>
          }
        />
        <SettingRow
          label={t('settings.about.license')}
          description={t('settings.about.licenseDesc')}
          control={<span className="abt-value">MIT</span>}
        />
        <SettingRow
          label={t('settings.about.sourceCode')}
          description={t('settings.about.sourceCodeDesc')}
          control={
            <a className="abt-github abt-github-sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Icon name="external-link" size={13} />
              GitHub
            </a>
          }
        />
      </SettingsCard>

      <SettingsCard title={t('first.title')} icon="info">
        <SettingRow label={t('first.title')} description={t('first.reopen')}
          control={<Button onClick={openFirstSteps}>{t('first.open')}</Button>} />
      </SettingsCard>

      <SettingsCard title={t('settings.about.statsTitle')} icon="activity">
        <AppStatistics
          totalDownloads={stats?.totalDownloads}
          totalUploaded={stats?.totalUploaded}
          totalDownloaded={stats?.totalDownloaded}
          cacheSize={stats?.cacheSize}
          diskUsage={stats?.diskUsage}
          activeDownloads={stats.activeDownloads}
          completedDownloads={stats.completedDownloads}
        />
      </SettingsCard>
    </>
  );
};
