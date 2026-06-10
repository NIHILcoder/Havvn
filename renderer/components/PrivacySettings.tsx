/**
 * Privacy & Anonymity
 *
 * Redesigned around a live "exposure dashboard": instead of a wall of toggles,
 * the top of the page answers the only question that matters for a torrent
 * client — "right now, what can the swarm see about me?" — using real VPN
 * detection plus the geo/ISP of the public IP (with a leak flag when the
 * torrent-facing IP looks like a consumer ISP rather than a VPN).
 *
 * Every control below maps to a setting that is actually wired into the engine
 * or the OS — nothing here is decorative.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Icon, IconName } from './Icon';
import { Toggle } from './Toggle';
import { Button } from './Button';
import { Alert } from './Alert';
import { PrivacyConfig, IpInfo } from '../../shared/types';
import { useTranslation } from '../utils/i18nContext';
import './PrivacySettings.css';

type Posture = 'checking' | 'protected' | 'caution' | 'exposed';

export const PrivacySettings: React.FC = () => {
  const { t } = useTranslation();
  // For keys built at runtime (posture/confidence). The static t() is strongly
  // typed against the dictionary, so dynamic lookups go through this view.
  const tk = t as (key: string) => string;

  const [config, setConfig] = useState<PrivacyConfig>({
    anonymousMode: true,
    encryptStorage: true,
    disableLogs: false,
    vpnCheck: true,
    clearDataOnExit: false,
    ephemeralPeerId: true,
    sanitizeLogs: true,
    vpnKillSwitch: false,
  });

  const [ip, setIp] = useState<IpInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [revealIp, setRevealIp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [dhtEnabled, setDhtEnabled] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'success' | 'info' | 'error'; text: string } | null>(null);
  const [busyPreset, setBusyPreset] = useState(false);

  const refreshIp = useCallback(async () => {
    setChecking(true);
    try {
      const info = await window.api.getIpInfo();
      setIp(info);
    } catch (e) {
      console.error('Failed to fetch IP info:', e);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, settings, enc] = await Promise.all([
          window.api.getPrivacyConfig(),
          window.api.getSettings(),
          window.api.isEncryptionAvailable().catch(() => true),
        ]);
        setConfig(cfg);
        setDhtEnabled(settings.enableDHT !== false);
        setEncryptionAvailable(enc);
      } catch (e) {
        console.error('Failed to load privacy settings:', e);
      }
    })();
    void refreshIp();
  }, [refreshIp]);

  const setCfg = async (key: keyof PrivacyConfig, value: boolean) => {
    const prev = config;
    setConfig({ ...config, [key]: value });
    try {
      await window.api.updatePrivacyConfig({ [key]: value });
    } catch (e) {
      console.error('Failed to save privacy setting:', e);
      setConfig(prev);
    }
  };

  const setDht = async (value: boolean) => {
    const prev = dhtEnabled;
    setDhtEnabled(value);
    try {
      await window.api.updateSettings({ enableDHT: value });
      setNotice({ kind: 'info', text: t('privacy.restartNote') });
    } catch (e) {
      console.error('Failed to update DHT:', e);
      setDhtEnabled(prev);
    }
  };

  const applyRecommended = async () => {
    setBusyPreset(true);
    try {
      await window.api.updatePrivacyConfig({ sanitizeLogs: true, vpnCheck: true, vpnKillSwitch: true });
      await window.api.updateSettings({ enableDHT: false });
      setConfig((c) => ({ ...c, sanitizeLogs: true, vpnCheck: true, vpnKillSwitch: true }));
      setDhtEnabled(false);
      setNotice({ kind: 'success', text: t('privacy.preset.applied') });
    } catch (e) {
      console.error('Failed to apply preset:', e);
      setNotice({ kind: 'error', text: t('privacy.preset.failed') });
    } finally {
      setBusyPreset(false);
    }
  };

  const copyIp = async () => {
    if (!ip?.ip) return;
    try {
      await navigator.clipboard.writeText(ip.ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const openLogs = async () => {
    try { await window.api.openLogsFolder(); } catch (e) { console.error(e); }
  };

  const clearLogs = async () => {
    try {
      const { removed } = await window.api.clearLogs();
      setNotice({ kind: 'success', text: t('privacy.logs.cleared').replace('{n}', String(removed)) });
    } catch (e) {
      console.error('Failed to clear logs:', e);
    }
  };

  const handleClearAllData = async () => {
    if (!confirm(t('privacy.confirm1'))) return;
    if (!confirm(t('privacy.confirm2'))) return;
    try {
      await window.api.clearAllData();
      alert(t('privacy.cleared'));
      window.location.reload();
    } catch (e) {
      console.error('Failed to clear data:', e);
      alert(t('privacy.clearFailed'));
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const posture: Posture = !ip
    ? 'checking'
    : !ip.vpnActive
      ? 'exposed'
      : (!config.vpnKillSwitch || !encryptionAvailable)
        ? 'caution'
        : 'protected';

  const score = computeScore({ ip, config, dhtEnabled, encryptionAvailable });

  const postureMeta: Record<Posture, { icon: string; key: string; descKey: string }> = {
    checking:  { icon: 'loader',          key: 'privacy.posture.checking',  descKey: 'privacy.posture.checkingDesc' },
    protected: { icon: 'shield',          key: 'privacy.posture.protected', descKey: 'privacy.posture.protectedDesc' },
    caution:   { icon: 'alert-triangle',  key: 'privacy.posture.caution',   descKey: 'privacy.posture.cautionDesc' },
    exposed:   { icon: 'alert-circle',    key: 'privacy.posture.exposed',   descKey: 'privacy.posture.exposedDesc' },
  };
  const pm = postureMeta[posture];

  const maskedIp = ip?.ip
    ? (revealIp ? ip.ip : ip.ip.replace(/[^.:]/g, '•'))
    : '—';
  const location = ip ? [ip.city, ip.region, ip.country].filter(Boolean).join(', ') : '';

  return (
    <div className="privacy-settings">
      <div className="settings-category-header">
        <h1 className="settings-category-title"><Icon name="shield" size={22} /> {t('privacy.title')}</h1>
        <p className="settings-category-subtitle">{t('privacy.subtitle')}</p>
      </div>

      {notice && (
        <div style={{ marginBottom: 16 }}>
          <Alert variant={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Alert>
        </div>
      )}

      {/* ── Posture hero ─────────────────────────────────────────────── */}
      <section className={`pv-hero pv-hero--${posture}`}>
        <div className={`pv-hero-icon ${posture === 'checking' ? 'spin' : ''}`}>
          <Icon name={pm.icon as IconName} size={28} />
        </div>
        <div className="pv-hero-text">
          <div className="pv-hero-status">{tk(pm.key)}</div>
          <div className="pv-hero-desc">{tk(pm.descKey)}</div>
        </div>
        <button className="pv-refresh" onClick={refreshIp} disabled={checking} title={t('privacy.refresh')}>
          <span className={checking ? 'spin' : ''}><Icon name="refresh-cw" size={16} /></span>
          {checking ? t('privacy.checking') : t('privacy.refresh')}
        </button>
      </section>

      {/* ── Exposure dashboard ───────────────────────────────────────── */}
      <section className="pv-dash">
        <div className="pv-dash-grid">
          {/* Public IP */}
          <div className="pv-cell">
            <div className="pv-cell-label"><Icon name="globe" size={13} /> {t('privacy.dash.publicIp')}</div>
            <div className="pv-cell-value pv-ip">
              <span className={`mono ${revealIp ? '' : 'masked'}`}>{maskedIp}</span>
              {ip?.ip && (
                <div className="pv-ip-actions">
                  <button className="pv-icon-btn" onClick={() => setRevealIp((v) => !v)} title={revealIp ? t('privacy.hide') : t('privacy.reveal')}>
                    <Icon name={revealIp ? 'eye-off' : 'eye'} size={14} />
                  </button>
                  <button className="pv-icon-btn" onClick={copyIp} title={t('privacy.copy')}>
                    <Icon name={copied ? 'check' : 'copy'} size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* VPN */}
          <div className="pv-cell">
            <div className="pv-cell-label"><Icon name="shield" size={13} /> {t('privacy.dash.vpn')}</div>
            <div className="pv-cell-value">
              {!ip ? '—' : ip.vpnActive ? (
                <span className="pv-badge pv-badge--ok"><Icon name="check-circle" size={13} /> {ip.vpnProvider || t('privacy.dash.vpnOn')}</span>
              ) : (
                <span className="pv-badge pv-badge--bad"><Icon name="alert-triangle" size={13} /> {t('privacy.dash.vpnOff')}</span>
              )}
              {ip && <span className="pv-conf">{t('privacy.vpn.confidence')}: {tk(`privacy.conf.${ip.confidence}`)}</span>}
            </div>
          </div>

          {/* ISP / Org */}
          <div className="pv-cell">
            <div className="pv-cell-label"><Icon name="server" size={13} /> {t('privacy.dash.isp')}</div>
            <div className="pv-cell-value">{ip?.org || '—'}</div>
          </div>

          {/* Location */}
          <div className="pv-cell">
            <div className="pv-cell-label"><Icon name="globe" size={13} /> {t('privacy.dash.location')}</div>
            <div className="pv-cell-value">{location || '—'}</div>
          </div>

          {/* Interfaces */}
          <div className="pv-cell pv-cell--wide">
            <div className="pv-cell-label"><Icon name="network" size={13} /> {t('privacy.dash.interfaces')}</div>
            <div className="pv-cell-value">
              {ip && ip.interfaces.length > 0
                ? <div className="pv-chips">{ip.interfaces.map((n) => <span key={n} className="pv-chip">{n}</span>)}</div>
                : <span className="pv-muted">{t('privacy.dash.noVpnIface')}</span>}
            </div>
          </div>
        </div>

        {/* Leak banner */}
        {ip?.exposedIsp && (
          <div className="pv-leak">
            <Icon name="alert-triangle" size={16} />
            <span>{t('privacy.leak.isp')}</span>
          </div>
        )}

        <div className="pv-dash-foot">
          <Icon name="info" size={12} />
          <span>{t('privacy.dash.whatPeersSee')}</span>
        </div>
      </section>

      {/* ── Recommended preset ───────────────────────────────────────── */}
      <section className="pv-preset">
        <div className="pv-preset-text">
          <div className="pv-preset-title"><Icon name="zap" size={16} /> {t('privacy.preset.title')}</div>
          <p className="pv-preset-desc">{t('privacy.preset.desc')}</p>
        </div>
        <Button variant="primary" onClick={applyRecommended} loading={busyPreset} disabled={busyPreset}>
          {t('privacy.preset.apply')}
        </Button>
      </section>

      {/* ── Anonymity ────────────────────────────────────────────────── */}
      <div className="settings-group">
        <h3 className="settings-group-title">{t('privacy.grp.anonymity')}</h3>

        <Row icon="refresh-cw" label={t('privacy.ephemeralId')} desc={t('privacy.ephemeralId.desc')}
          control={<span className="privacy-status on"><Icon name="check-circle" size={14} /> {t('privacy.alwaysOn')}</span>} />

        <Row icon="shield" label={t('privacy.vpnDetection')} desc={t('privacy.vpnDetection.desc')}
          control={<Toggle checked={config.vpnCheck} onChange={(v) => setCfg('vpnCheck', v)} />} />

        <Row icon="power" label={t('privacy.killSwitch')} desc={t('privacy.killSwitch.desc')}
          control={<Toggle checked={config.vpnKillSwitch} onChange={(v) => setCfg('vpnKillSwitch', v)} />} />
      </div>

      {/* ── Connection privacy ───────────────────────────────────────── */}
      <div className="settings-group">
        <h3 className="settings-group-title">{t('privacy.grp.connection')}</h3>

        <Row icon="network" label={t('privacy.dht')} desc={t('privacy.dht.desc')}
          control={<Toggle checked={dhtEnabled} onChange={setDht} />} />

        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('privacy.connection.note')}</span>
        </div>
      </div>

      {/* ── Data protection ──────────────────────────────────────────── */}
      <div className="settings-group">
        <h3 className="settings-group-title">{t('privacy.grp.dataProtection')}</h3>

        <Row icon="lock" label={t('privacy.encSecrets')} desc={t('privacy.encSecrets.desc')}
          control={encryptionAvailable
            ? <span className="privacy-status on"><Icon name="check-circle" size={14} /> {t('privacy.active')}</span>
            : <span className="privacy-status off"><Icon name="alert-triangle" size={14} /> {t('privacy.unavailable')}</span>} />

        <Row icon="trash" label={t('privacy.clearOnExit')} desc={t('privacy.clearOnExit.desc')}
          control={<Toggle checked={config.clearDataOnExit} onChange={(v) => setCfg('clearDataOnExit', v)} />} />
      </div>

      {/* ── Logging ──────────────────────────────────────────────────── */}
      <div className="settings-group">
        <h3 className="settings-group-title">{t('privacy.grp.logging')}</h3>

        <Row icon="file-text" label={t('privacy.sanitizeLogs')} desc={t('privacy.sanitizeLogs.desc')}
          control={<Toggle checked={config.sanitizeLogs} onChange={(v) => setCfg('sanitizeLogs', v)} />} />

        <Row icon="x-circle" label={t('privacy.disableLogs')} desc={t('privacy.disableLogs.desc')}
          control={<Toggle checked={config.disableLogs} onChange={(v) => setCfg('disableLogs', v)} />} />

        <div className="pv-actions">
          <Button variant="secondary" onClick={openLogs}><Icon name="folder-open" size={15} /> {t('privacy.logs.open')}</Button>
          <Button variant="secondary" onClick={clearLogs}><Icon name="trash" size={15} /> {t('privacy.logs.clear')}</Button>
        </div>
      </div>

      {/* ── Privacy score ────────────────────────────────────────────── */}
      <div className="privacy-score">
        <h3>{t('privacy.score')}</h3>
        <div className="score-bar">
          <div className="score-fill" style={{ width: `${score}%`, backgroundColor: scoreColor(score) }} />
        </div>
        <div className="score-label">{score}/100 — {t(scoreLabelKey(score))}</div>
      </div>

      {/* ── Danger zone ──────────────────────────────────────────────── */}
      <div className="settings-group danger-zone">
        <h3 className="settings-group-title"><Icon name="alert-triangle" size={16} /> {t('privacy.grp.danger')}</h3>
        <Row icon="alert-triangle" label={t('privacy.clearAll')} desc={t('privacy.clearAll.desc')}
          control={<Button variant="danger" onClick={handleClearAllData}><Icon name="trash" size={16} /> {t('privacy.clearAll')}</Button>} />
      </div>

      {/* ── Tips ─────────────────────────────────────────────────────── */}
      <div className="privacy-tips">
        <h3><Icon name="info" size={16} /> {t('privacy.tips.title')}</h3>
        <ul>
          <li><strong>{t('privacy.tips.vpn')}</strong> {t('privacy.tips.vpnText')}</li>
          <li><strong>{t('privacy.tips.killSwitch')}</strong> {t('privacy.tips.killSwitchText')}</li>
          <li><strong>{t('privacy.tips.dht')}</strong> {t('privacy.tips.dhtText')}</li>
          <li><strong>{t('privacy.tips.private')}</strong> {t('privacy.tips.privateText')}</li>
          <li><strong>{t('privacy.tips.check')}</strong> {t('privacy.tips.checkText')}</li>
        </ul>
      </div>
    </div>
  );
};

// Small presentational row to keep the markup flat and consistent.
const Row: React.FC<{ icon: IconName; label: string; desc: string; control: React.ReactNode }> = ({ icon, label, desc, control }) => (
  <div className="setting-item">
    <div className="setting-info">
      <label className="setting-label"><Icon name={icon} size={16} /> {label}</label>
      <p className="setting-description">{desc}</p>
    </div>
    <div className="setting-control">{control}</div>
  </div>
);

function computeScore(p: { ip: IpInfo | null; config: PrivacyConfig; dhtEnabled: boolean; encryptionAvailable: boolean }): number {
  let s = 0;
  s += 10;                                   // ephemeral peer ID (always on)
  if (p.encryptionAvailable) s += 10;        // OS-level secret encryption
  if (p.ip?.vpnActive) s += 40;              // VPN is the dominant real-anonymity factor
  if (p.config.vpnKillSwitch) s += 15;       // protects against VPN drops
  if (!p.dhtEnabled) s += 10;                // smaller exposure surface
  if (p.config.sanitizeLogs) s += 8;
  if (p.config.clearDataOnExit) s += 7;
  return Math.min(100, s);
}

function scoreColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 55) return '#f59e0b';
  return '#ef4444';
}

type ScoreLabelKey = 'privacy.score.excellent' | 'privacy.score.good' | 'privacy.score.fair' | 'privacy.score.poor';
function scoreLabelKey(score: number): ScoreLabelKey {
  if (score >= 80) return 'privacy.score.excellent';
  if (score >= 55) return 'privacy.score.good';
  if (score >= 35) return 'privacy.score.fair';
  return 'privacy.score.poor';
}
