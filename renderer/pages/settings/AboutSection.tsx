/**
 * Settings → About section.
 *
 * Extracted verbatim from SettingsPage's renderAboutSettings() — animated hero
 * (version/beta/tech pills, update/make-default/GitHub actions) + the statistics
 * panel. Behaviour is unchanged; it relies on the global SettingsPage.css already
 * loaded by the parent page.
 */

import React from 'react';
import { Button, Icon, AppStatistics } from '../../components';
import { useTranslation } from '../../utils/i18nContext';

interface AboutStats {
  totalDownloads: number;
  totalUploaded: string;
  totalDownloaded: string;
  cacheSize: string;
  diskUsage: string;
  uptime: string;
}

interface AboutSectionProps {
  appVersion: string;
  updateReady: string | null;
  isDefaultClient: boolean;
  setIsDefaultClient: (v: boolean) => void;
  stats: AboutStats;
}

export const AboutSection: React.FC<AboutSectionProps> = ({
  appVersion,
  updateReady,
  isDefaultClient,
  setIsDefaultClient,
  stats,
}) => {
  const { t } = useTranslation();

  return (
    <>
      <div className="settings-category-header">
        <h1 className="settings-category-title">{t('settings.hdr.about')}</h1>
        <p className="settings-category-subtitle">{t('settings.sub.about')}</p>
      </div>

      <div className="about-section">
        {/* Animated hero */}
        <div className="about-hero">
          <div className="about-hero-glow" />
          <div className="about-logo">
            <div className="about-logo-ring" />
            <div className="about-logo-tile"><Icon name="download" size={30} /></div>
          </div>
          <div className="about-hero-text">
            <h2 className="about-app-name">TorrentHunt</h2>
            <div className="about-badges">
              <span className="about-pill about-pill--ver">v{appVersion || '—'}</span>
              {/(alpha|beta|rc)/i.test(appVersion) && (
                <span className="about-pill about-pill--beta">beta</span>
              )}
              <span className="about-pill about-pill--soft">Electron · React · WebTorrent</span>
              <span className="about-pill about-pill--soft">MIT</span>
            </div>
            <p className="about-description">{t('settings.appDesc')}</p>

            <div className="about-actions">
              {updateReady ? (
                <Button variant="primary" onClick={() => window.api.quitAndInstallUpdate()}
                  icon={<Icon name="refresh-cw" size={15} />}>
                  {t('settings.restartInstall')}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => window.api.checkForUpdates()}
                  icon={<Icon name="refresh-cw" size={15} />}>
                  {t('settings.checkUpdates')}
                </Button>
              )}
              {!isDefaultClient && (
                <Button variant="secondary" onClick={async () => {
                  const r = await window.api.setDefaultClient();
                  if (r?.success) setIsDefaultClient(true);
                }} icon={<Icon name="check-circle" size={15} />}>
                  {t('settings.makeDefault')}
                </Button>
              )}
              {isDefaultClient && (
                <span className="about-default-ok"><Icon name="check-circle" size={15} /> {t('settings.isDefault')}</span>
              )}
              <a className="about-link-btn" href="https://github.com/NIHILcoder/TorrentHunt" target="_blank" rel="noreferrer">
                <Icon name="external-link" size={15} /> GitHub
              </a>
            </div>
          </div>
        </div>

        <div className="settings-group about-stats-group">
          <h3 className="settings-group-title">{t('settings.grp.statistics')}</h3>
          <AppStatistics
            totalDownloads={stats.totalDownloads}
            totalUploaded={stats.totalUploaded}
            totalDownloaded={stats.totalDownloaded}
            cacheSize={stats.cacheSize}
            diskUsage={stats.diskUsage}
            uptime={stats.uptime}
          />
        </div>
      </div>
    </>
  );
};
