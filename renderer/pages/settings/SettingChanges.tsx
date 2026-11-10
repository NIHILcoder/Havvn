import React from 'react';
import { useSettings } from './SettingsContext';
import { useTranslation } from '../../utils/i18nContext';
import { Button } from '../../components/Button';

export interface SettingChange { id: string; label: string; before: string; after: string; section: string; reset(): void; ownSave?: boolean }
export function useSettingChanges(): SettingChange[] {
  const ctx = useSettings(), { t } = useTranslation(), s = ctx.settings;
  if (!s) return [];
  const changes: SettingChange[] = [];
  const add = (id: string, label: string, value: string | number, saved: string | number, reset: () => void, section: string, sensitive = false) => {
    if (value === saved) return;
    const show = (v: string | number) => sensitive ? (v ? t('settings.review.hidden') : t('settings.review.empty')) : String(v || (v === 0 ? 0 : t('settings.review.empty')));
    changes.push({ id, label, before: show(saved), after: show(value), reset, section });
  };
  add('defaultDownloadDir', t('settings.defaultDir'), ctx.defaultDownloadDir, s.defaultDownloadDir ?? '', () => ctx.setDefaultDownloadDir(s.defaultDownloadDir ?? ''), 'downloads');
  add('maxDownKbps', t('settings.downSpeed'), ctx.maxDownKbps, s.maxDownKbps ?? 0, () => ctx.setMaxDownKbps(s.maxDownKbps ?? 0), 'connection');
  add('maxUpKbps', t('settings.upSpeed'), ctx.maxUpKbps, s.maxUpKbps ?? 0, () => ctx.setMaxUpKbps(s.maxUpKbps ?? 0), 'connection');
  add('altDownKbps', t('settings.altDown'), ctx.altDownKbps, s.altDownKbps ?? 0, () => ctx.setAltDownKbps(s.altDownKbps ?? 0), 'connection');
  add('altUpKbps', t('settings.altUp'), ctx.altUpKbps, s.altUpKbps ?? 0, () => ctx.setAltUpKbps(s.altUpKbps ?? 0), 'connection');
  add('maxActiveDownloads', t('settings.maxActive'), ctx.maxActiveDownloads, s.maxActiveDownloads ?? 3, () => ctx.setMaxActiveDownloads(s.maxActiveDownloads ?? 3), 'downloads');
  add('maxConnections', t('settings.maxConn'), ctx.maxConnections, s.maxConnections ?? 55, () => ctx.setMaxConnections(s.maxConnections ?? 55), 'connection');
  add('maxConnectionsGlobal', t('settings.maxConnGlobal'), ctx.maxConnectionsGlobal, s.maxConnectionsGlobal ?? 200, () => ctx.setMaxConnectionsGlobal(s.maxConnectionsGlobal ?? 200), 'connection');
  add('portMin', t('settings.port'), ctx.portMin, s.portMin ?? 6881, () => ctx.setPortMin(s.portMin ?? 6881), 'connection');
  add('watchFolderPath', t('settings.watchPath'), ctx.watchFolderPath, s.watchFolderPath ?? '', () => ctx.setWatchFolderPath(s.watchFolderPath ?? ''), 'downloads');
  add('autoMovePath', t('settings.autoMovePath'), ctx.autoMovePath, s.autoMovePath ?? '', () => ctx.setAutoMovePath(s.autoMovePath ?? ''), 'downloads');
  add('diskGuardMinFreeMB', t('settings.diskMin'), ctx.diskGuardMinFreeMB, s.diskGuardMinFreeMB ?? 2048, () => ctx.setDiskGuardMinFreeMB(s.diskGuardMinFreeMB ?? 2048), 'downloads');
  add('defaultSeedRatioLimit', t('settings.seedRatio'), ctx.defaultSeedRatioLimit, s.defaultSeedRatioLimit ?? 0, () => ctx.setDefaultSeedRatioLimit(s.defaultSeedRatioLimit ?? 0), 'seeding');
  add('defaultSeedTimeLimitMinutes', t('settings.seedTime'), ctx.defaultSeedTimeLimitMinutes, s.defaultSeedTimeLimitMinutes ?? 0, () => ctx.setDefaultSeedTimeLimitMinutes(s.defaultSeedTimeLimitMinutes ?? 0), 'seeding');
  add('proxyHost', t('settings.proxyHost'), ctx.proxyHost, s.proxyHost ?? '', () => ctx.setProxyHost(s.proxyHost ?? ''), 'connection', true);
  add('proxyPort', t('settings.proxyPort'), ctx.proxyPort, s.proxyPort ?? 8080, () => ctx.setProxyPort(s.proxyPort ?? 8080), 'connection');
  add('proxyType', t('settings.proxyType'), ctx.proxyType, s.proxyType === 'https' || s.proxyType === 'socks5' ? s.proxyType : 'http', () => ctx.setProxyType(s.proxyType === 'https' || s.proxyType === 'socks5' ? s.proxyType : 'http'), 'connection');
  add('proxyUsername', t('settings.proxyUser'), ctx.proxyUsername, s.proxyUsername ?? '', () => ctx.setProxyUsername(s.proxyUsername ?? ''), 'connection', true);
  add('proxyPassword', t('settings.proxyPass'), ctx.proxyPassword, s.proxyPassword ?? '', () => ctx.setProxyPassword(s.proxyPassword ?? ''), 'connection', true);
  if (ctx.schedulerConfig && JSON.stringify(ctx.schedules) !== JSON.stringify(ctx.schedulerConfig.schedules)) changes.push({ id: 'schedules', label: t('settings.review.schedules'), before: String(ctx.schedulerConfig.schedules.length), after: String(ctx.schedules.length), section: 'scheduler', reset: () => ctx.setSchedules(structuredClone(ctx.schedulerConfig!.schedules)) });
  const own = (id: string, label: string, section: string, reset: () => void) => changes.push({ id, label, section, before: t('settings.review.savedVersion'), after: t('settings.review.blockChanged'), reset, ownSave: true });
  if (ctx.netDraft) own('network', t('settings.review.network'), 'connection', () => ctx.setNetDraft(null));
  if (ctx.turnUrl !== (s.customTurnUrl ?? '') || ctx.turnUser !== (s.customTurnUsername ?? '') || ctx.turnCred !== (s.customTurnCredential ?? '')) own('turn', t('settings.review.turn'), 'sharing', () => { ctx.setTurnUrl(s.customTurnUrl ?? ''); ctx.setTurnUser(s.customTurnUsername ?? ''); ctx.setTurnCred(s.customTurnCredential ?? ''); });
  if (ctx.customTrackers !== (s.customTrackers ?? '')) own('trackers', t('settings.review.trackers'), 'sharing', () => ctx.setCustomTrackers(s.customTrackers ?? ''));
  return changes;
}
export function SettingsChangeReview({ changes, disabled, navigate }: { changes: SettingChange[]; disabled: boolean; navigate(section: string): void }) {
  const { t } = useTranslation();
  if (!changes.length) return null;
  return <details className="stg-change-review">
    <summary>{t('settings.review.title').replace('{count}', String(changes.length))}</summary>
    <div className="stg-change-review-body">
    <ul>{changes.map(change => <li key={change.id}>
      <div><strong>{change.label}</strong><p className="stg-change-values"><span className="stg-change-value" title={change.before}>{change.before}</span><span>→</span><span className="stg-change-value" title={change.after}>{change.after}</span></p>{change.ownSave && <small>{t('settings.review.ownSave')}</small>}</div>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => navigate(change.section)}>{t('settings.review.open')}</Button>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={change.reset}>{t('settings.review.reset')}</Button>
    </li>)}</ul>
    <p>{t('settings.review.hint')}</p>
    </div>
  </details>;
}
