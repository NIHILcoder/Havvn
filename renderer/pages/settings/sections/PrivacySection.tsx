/**
 * Settings → Privacy section — rebuilt natively on the settings primitives
 * (SettingsCard / SettingRow / StatusPill), absorbing the logic of the legacy
 * <PrivacySettings /> component (which drew its own page header, hero, rows
 * and score bar and looked alien inside the new settings shell).
 *
 * Cards:
 *  1. Exposure  — live IP/VPN/ISP dashboard from getIpInfo() with a posture
 *                 verdict strip and a refresh button.
 *  2. Protection — vpnCheck / kill-switch / DHT (through ctx.applyToggle so the
 *                 Connection tab stays in sync) / clear-on-exit / encryption
 *                 status / recommended preset.
 *  3. DNS-over-HTTPS — unchanged from the previous section version.
 *  4. Logs      — sanitize / disable toggles + open-folder / clear actions.
 *  5. Danger zone — Clear all data behind the app-wide confirm dialog.
 *
 * All feedback goes through ctx.setMessage (the shell toast) instead of the
 * legacy component-local <Alert>.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, StatusPill, RestartPendingNotice } from '../controls';
import { Icon, IconName, Button, Toggle } from '../../../components';
import { useConfirm } from '../../../components/ConfirmDialog';
import { PrivacyConfig, IpInfo, VpnBindReport } from '../../../../shared/types';
import { privacyPosture, type PrivacyPosture as Posture } from '../../../../shared/vpn-status';
import { useTranslation } from '../../../utils/i18nContext';
import '../../../components/PrivacySettings.css';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export const PrivacySection: React.FC = () => {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  const {
    engine, runningEngine, applyToggle, setMessage,
    enableDHT, setEnableDHT,
    dohEnabled, setDohEnabled, dohTemplateId, dohTemplates,
    dohNewName, setDohNewName, dohNewUrl, setDohNewUrl, dohAdding, dohTest,
    selectDohTemplate, addDohTemplate, deleteDohTemplate, testDohTemplate,
  } = useSettings();

  // ── Local privacy-config state (absorbed from the legacy component) ──────
  const [config, setConfig] = useState<PrivacyConfig>({
    anonymousMode: true,
    encryptStorage: true,
    disableLogs: false,
    vpnCheck: true,
    clearDataOnExit: false,
    ephemeralPeerId: true,
    sanitizeLogs: true,
    vpnKillSwitch: false,
    vpnBindEngine: false,
  });
  const [bindStatus, setBindStatus] = useState<VpnBindReport | null>(null);
  const [ip, setIp] = useState<IpInfo | null>(null);
  const [ipFailed, setIpFailed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [revealIp, setRevealIp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [busyPreset, setBusyPreset] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);
  const refreshId = useRef(0);
  const cancelRefresh = useCallback(() => {
    active.current = false;
    refreshId.current++;
    pending.current = false;
  }, []);

  const refreshBindStatus = useCallback(async () => {
    try {
      const bs = await window.api.getVpnBindStatus();
      if (bs) setBindStatus(bs);
    } catch {
      /* older main without the handler — leave the status area empty */
    }
  }, []);

  const refreshIp = useCallback(async () => {
    if (!active.current || pending.current) return;
    pending.current = true;
    const id = ++refreshId.current;
    setChecking(true);
    try {
      const info = await window.api.getIpInfo();
      if (!active.current || id !== refreshId.current) return;
      // Guard: in tests / degraded IPC the call resolves undefined.
      if (info && typeof info === 'object') {
        setIp(info);
        setIpFailed(!info.ip);
      } else {
        setIp(null);
        setIpFailed(true);
      }
    } catch (e) {
      if (!active.current || id !== refreshId.current) return;
      console.error('Failed to fetch IP info:', e);
      setIp(null);
      setIpFailed(true);
    } finally {
      if (id === refreshId.current) {
        pending.current = false;
        if (active.current) setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    let alive = true;
    void (async () => {
      try {
        const cfg = await window.api.getPrivacyConfig();
        if (alive && cfg) setConfig(cfg);
      } catch (e) {
        console.error('Failed to load privacy config:', e);
      }
      try {
        const enc = await window.api.isEncryptionAvailable();
        if (alive) setEncryptionAvailable(enc !== false);
      } catch {
        /* keep optimistic default */
      }
    })();
    void refreshIp();
    void refreshBindStatus();
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') { void refreshIp(); void refreshBindStatus(); }
    };
    const interval = setInterval(refreshVisible, 30_000);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('online', refreshVisible);
    return () => {
      alive = false; cancelRefresh();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('online', refreshVisible);
    };
  }, [refreshIp, refreshBindStatus, cancelRefresh]);

  // Keep the bind status fresh when the guard re-binds / loses the VPN.
  useEffect(() => {
    const off = window.api.onVpnBindStatus(() => { void refreshBindStatus(); void refreshIp(); });
    return () => off();
  }, [refreshBindStatus, refreshIp]);

  // Optimistic single-flag save with rollback + shell toast on failure.
  const setCfg = async (key: keyof PrivacyConfig, value: boolean) => {
    const prev = config;
    setConfig({ ...config, [key]: value });
    try {
      await window.api.updatePrivacyConfig({ [key]: value });
    } catch (e) {
      console.error('Failed to save privacy setting:', e);
      setConfig(prev);
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
    }
  };

  const applyRecommended = async () => {
    setBusyPreset(true);
    try {
      const patch: Partial<PrivacyConfig> = { sanitizeLogs: true, vpnCheck: true, vpnKillSwitch: true };
      await window.api.updatePrivacyConfig(patch);
      setConfig((c) => ({ ...c, sanitizeLogs: true, vpnCheck: true, vpnKillSwitch: true }));
      // DHT goes through the shared controller so the Connection tab reflects it.
      await applyToggle(false, setEnableDHT, { enableDHT: false });
      setMessage({ type: 'success', text: t('privacy.preset.applied') });
    } catch (e) {
      console.error('Failed to apply preset:', e);
      setMessage({ type: 'error', text: t('privacy.preset.failed') });
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
      const res = await window.api.clearLogs();
      const removed = res?.removed ?? 0;
      setMessage({ type: 'success', text: t('privacy.logs.cleared').replace('{n}', String(removed)) });
    } catch (e) {
      console.error('Failed to clear logs:', e);
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
    }
  };

  const handleClearAllData = async () => {
    if (!(await confirm({ message: t('privacy.confirm1'), danger: true }))) return;
    if (!(await confirm({ message: t('privacy.confirm2'), danger: true }))) return;
    try {
      await window.api.clearAllData();
      await alert({ message: t('privacy.cleared') });
      window.location.reload();
    } catch (e) {
      console.error('Failed to clear data:', e);
      await alert({ message: t('privacy.clearFailed') });
    }
  };

  // ── Posture verdict (replaces the legacy score bar, whose value mixed a
  //    constant with loading state and read misleadingly low while checking) ─
  const posture = privacyPosture(ip?.state, checking, config.vpnKillSwitch);

  const verdict: Record<Posture, { icon: IconName; tone: Tone; title: string; desc: string }> = {
    checking:  { icon: 'loader',         tone: 'muted', title: t('privacy.posture.checking'),  desc: t('privacy.posture.checkingDesc') },
    unknown:   { icon: 'help-circle',    tone: 'muted', title: t('privacy.vpn.unknown'),       desc: t('privacy.vpn.unknownDesc') },
    protected: { icon: 'shield',         tone: 'ok',    title: t('privacy.posture.protected'), desc: t('privacy.posture.protectedDesc') },
    caution:   { icon: 'alert-triangle', tone: 'warn',  title: t('privacy.posture.caution'),   desc: t('privacy.posture.cautionDesc') },
    exposed:   { icon: 'alert-circle',   tone: 'bad',   title: t('privacy.posture.exposed'),   desc: t('privacy.posture.exposedDesc') },
  };
  const v = ip?.state === 'detected' && !checking
    ? { icon: 'alert-triangle' as IconName, tone: 'warn' as Tone, title: t('privacy.route.detected'), desc: t('privacy.route.detectedDesc') }
    : verdict[posture];

  const maskedIp = ip?.ip ? (revealIp ? ip.ip : ip.ip.replace(/[^.:]/g, '•')) : '—';
  const location = ip ? [ip.city, ip.region, ip.country].filter(Boolean).join(', ') : '';
  const interfaces = ip?.interfaces ?? [];
  // Same native-only gating as the DoH card below: the engine that is actually
  // RUNNING decides, falling back to the configured one before first load.
  const isNativeEngine = (runningEngine ?? engine) === 'native';

  return (
    <>
      {/* ── 1. Exposure ─────────────────────────────────────────────────── */}
      <SettingsCard title={t('privacy.grp.exposure')} icon="globe" description={t('privacy.subtitle')}>
        <div className={`pv-verdict pv-verdict--${v.tone}`}>
          <span className="pv-verdict-icon">
            <span className={posture === 'checking' ? 'spin' : undefined}>
              <Icon name={v.icon} size={20} />
            </span>
          </span>
          <span className="pv-verdict-text">
            <span className="pv-verdict-title">{v.title}</span>
            <span className="pv-verdict-desc">{v.desc}</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={refreshIp}
            loading={checking}
            disabled={checking}
            icon={<Icon name="refresh-cw" size={14} />}
          >
            {checking ? t('privacy.checking') : t('privacy.refresh')}
          </Button>
        </div>

        <div className="pv-dashwrap">
          <div className="pv-dash-grid">
            {/* Public IP */}
            <div className="pv-cell">
              <div className="pv-cell-label"><Icon name="globe" size={13} /> {t('privacy.dash.publicIp')}</div>
              <div className="pv-cell-value pv-ip">
                <span className={`mono ${revealIp ? '' : 'masked'}`}>{maskedIp}</span>
                {(ip?.ip || ip?.proxyIp) && (
                  <span className="pv-ip-actions">
                    <button
                      className="pv-icon-btn"
                      onClick={() => setRevealIp((r) => !r)}
                      title={revealIp ? t('privacy.hide') : t('privacy.reveal')}
                      aria-label={revealIp ? t('privacy.hide') : t('privacy.reveal')}
                    >
                      <Icon name={revealIp ? 'eye-off' : 'eye'} size={14} />
                    </button>
                    <button
                      className="pv-icon-btn"
                      onClick={copyIp}
                      disabled={!ip?.ip}
                      title={t('privacy.copy')}
                      aria-label={t('privacy.copy')}
                    >
                      <Icon name={copied ? 'check' : 'copy'} size={14} />
                    </button>
                  </span>
                )}
              </div>
            </div>

            {/* VPN */}
            <div className="pv-cell">
              <div className="pv-cell-label"><Icon name="shield" size={13} /> {t('privacy.dash.vpn')}</div>
              <div className="pv-cell-value">
                {!ip ? '—' : <span className={`pv-badge ${ip.state === 'routed' ? 'pv-badge--ok' : ''}`}>
                  <Icon name={ip.state === 'routed' ? 'check-circle' : 'help-circle'} size={13} />
                  {t(`privacy.route.${ip.state}`)}
                </span>}
                {ip?.confidence && (
                  <span className="pv-conf">{t('privacy.vpn.confidence')}: {t(`privacy.conf.${ip.confidence}`)}</span>
                )}
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

            {/* VPN interfaces */}
            <div className="pv-cell pv-cell--wide">
              <div className="pv-cell-label"><Icon name="network" size={13} /> {t('privacy.dash.proxy')}</div>
              <div className="pv-cell-value">
                {ip?.proxyConfigured == null ? t('privacy.conf.unknown') : ip.proxyConfigured ? t('privacy.dash.proxyOn') : t('privacy.dash.proxyOff')}
                {ip?.proxyIp && <span className="mono"> · {revealIp ? ip.proxyIp : ip.proxyIp.replace(/[^.:]/g, '•')}{ip.proxyCountry ? ` (${ip.proxyCountry})` : ''}</span>}
              </div>
              <div className="pv-muted">{t('privacy.dash.proxyNote')}</div>
            </div>
            <div className="pv-cell pv-cell--wide">
              <div className="pv-cell-label"><Icon name="network" size={13} /> {t('privacy.dash.interfaces')}</div>
              <div className="pv-cell-value">
                {interfaces.length > 0
                  ? <span className="pv-chips">{interfaces.map((n) => <span key={n} className="pv-chip">{n}</span>)}</span>
                  : <span className="pv-muted">{t('privacy.dash.noVpnIface')}</span>}
              </div>
            </div>
          </div>

          {ip?.ipv6Bypass && (
            <div className="pv-leak">
              <Icon name="alert-triangle" size={16} />
              <span>{t('privacy.route.ipv6Bypass')}</span>
            </div>
          )}
          {ipFailed && !checking && (
            <div className="settings-notice-compact warn">
              <Icon name="alert-triangle" size={14} />
              <span>{t('privacy.dash.ipUnavailable')}</span>
            </div>
          )}
        </div>

        <div className="pv-dash-foot">
          <Icon name="info" size={12} />
          <span>{t('privacy.dash.whatPeersSee')}</span>
        </div>
      </SettingsCard>

      {/* ── 2. Protection ───────────────────────────────────────────────── */}
      <SettingsCard title={t('privacy.grp.protection')} icon="shield">
        <SettingRow
          icon="refresh-cw"
          label={t('privacy.ephemeralId')}
          description={t('privacy.ephemeralId.desc')}
          control={
            <StatusPill tone="ok">
              <Icon name="check-circle" size={11} /> {t('privacy.alwaysOn')}
            </StatusPill>
          }
        />
        <SettingRow
          icon="shield"
          label={t('privacy.vpnDetection')}
          description={t('privacy.vpnDetection.desc')}
          control={
            <Toggle
              checked={config.vpnCheck}
              onChange={(val) => setCfg('vpnCheck', val)}
              ariaLabel={t('privacy.vpnDetection')}
            />
          }
        />
        <SettingRow
          icon="power"
          label={t('privacy.killSwitch')}
          description={t('privacy.killSwitch.desc')}
          control={
            <Toggle
              checked={config.vpnKillSwitch}
              onChange={(val) => setCfg('vpnKillSwitch', val)}
              ariaLabel={t('privacy.killSwitch')}
            />
          }
        />
        <SettingRow
          icon="link"
          label={t('privacy.vpnBind')}
          description={isNativeEngine ? t('privacy.vpnBind.desc') : t('privacy.vpnBind.engineOnly')}
          control={
            <Toggle
              checked={config.vpnBindEngine === true}
              disabled={!isNativeEngine}
              onChange={(val) => setCfg('vpnBindEngine', val)}
              ariaLabel={t('privacy.vpnBind')}
            />
          }
        />
        {isNativeEngine && bindStatus?.running && (config.vpnBindEngine === true) !== bindStatus.running.enabled && (
          <RestartPendingNotice text={t('privacy.vpnBind.pending')} />
        )}
        {bindStatus?.running?.enabled && bindStatus.running.fallback && (
          <div className="settings-notice-compact warn">
            <Icon name="alert-triangle" size={14} />
            <span>{t('privacy.vpnBind.noVpn')}</span>
          </div>
        )}
        {bindStatus?.running?.enabled && !bindStatus.running.fallback && bindStatus.running.boundIp && (
          <div className="settings-notice-compact">
            <Icon name="check-circle" size={14} />
            <span>{t('privacy.vpnBind.bound')} {bindStatus.running.iface} ({bindStatus.running.boundIp})</span>
          </div>
        )}
        <SettingRow
          icon="network"
          label={t('privacy.dht')}
          description={t('privacy.dht.desc')}
          control={
            <Toggle
              checked={enableDHT}
              onChange={(val) => applyToggle(val, setEnableDHT, { enableDHT: val })}
              ariaLabel={t('privacy.dht')}
            />
          }
        />
        <SettingRow
          icon="trash"
          label={t('privacy.clearOnExit')}
          description={t('privacy.clearOnExit.desc')}
          control={
            <Toggle
              checked={config.clearDataOnExit}
              onChange={(val) => setCfg('clearDataOnExit', val)}
              ariaLabel={t('privacy.clearOnExit')}
            />
          }
        />
        <SettingRow
          icon="lock"
          label={t('privacy.encSecrets')}
          description={t('privacy.encSecrets.desc')}
          control={
            encryptionAvailable ? (
              <StatusPill tone="ok"><Icon name="check-circle" size={11} /> {t('privacy.active')}</StatusPill>
            ) : (
              <StatusPill tone="accent"><Icon name="alert-triangle" size={11} /> {t('privacy.unavailable')}</StatusPill>
            )
          }
        />
        <SettingRow
          icon="zap"
          label={t('privacy.preset.title')}
          description={t('privacy.preset.desc')}
          control={
            <Button variant="primary" onClick={applyRecommended} loading={busyPreset} disabled={busyPreset}>
              {t('privacy.preset.apply')}
            </Button>
          }
        />
        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('privacy.connection.note')}</span>
        </div>
      </SettingsCard>

      {/* ── 3. DNS-over-HTTPS (unchanged) ───────────────────────────────── */}
      <SettingsCard title={t('settings.grp.doh')} icon="globe">
        {isNativeEngine && (
          <div className="settings-notice-compact warn">
            <Icon name="alert-triangle" size={14} />
            <span>{t('settings.doh.engineWarn')}</span>
          </div>
        )}

        <SettingRow
          label={t('settings.doh')}
          description={t('settings.doh.desc')}
          control={
            <Toggle
              checked={dohEnabled}
              onChange={() => applyToggle(!dohEnabled, setDohEnabled, { dohEnabled: !dohEnabled })}
              ariaLabel={t('settings.doh')}
            />
          }
        />

        {dohEnabled && (
          <div className="doh-panel">
            <div className="doh-resolvers">
              {dohTemplates.map((tpl) => (
                <div key={tpl.id} className={`doh-resolver ${dohTemplateId === tpl.id ? 'active' : ''}`}>
                  <label className="doh-resolver-pick">
                    <input
                      type="radio"
                      name="doh-resolver"
                      checked={dohTemplateId === tpl.id}
                      onChange={() => selectDohTemplate(tpl.id)}
                    />
                    <span className="doh-resolver-info">
                      <span className="doh-resolver-name">{tpl.name}{!tpl.builtIn && <span className="doh-badge">{t('settings.doh.custom')}</span>}</span>
                      <span className="doh-resolver-url">{tpl.url}</span>
                      {dohTest && dohTest.id === tpl.id && (
                        <span className={`doh-test-result ${dohTest.state}`}>{dohTest.text}</span>
                      )}
                    </span>
                  </label>
                  <div className="doh-resolver-actions">
                    <button className="doh-mini-btn" onClick={() => testDohTemplate(tpl)} title={t('settings.doh.test')}>
                      <Icon name="activity" size={13} />
                    </button>
                    {!tpl.builtIn && (
                      <button className="doh-mini-btn danger" onClick={() => deleteDohTemplate(tpl.id)} title={t('settings.doh.delete')}>
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Add a custom resolver */}
            <div className="doh-add">
              <div className="doh-add-title">{t('settings.doh.addTitle')}</div>
              <div className="doh-add-row">
                <input
                  className="input-compact doh-add-name"
                  placeholder={t('settings.doh.namePlaceholder')}
                  value={dohNewName}
                  onChange={(e) => setDohNewName(e.target.value)}
                />
                <input
                  className="input-compact input-mono doh-add-url"
                  placeholder="https://1.1.1.1/dns-query"
                  value={dohNewUrl}
                  onChange={(e) => setDohNewUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addDohTemplate()}
                />
                <Button variant="secondary" size="sm" onClick={addDohTemplate} loading={dohAdding} disabled={!dohNewUrl.trim()} icon={<Icon name="plus" size={14} />}>
                  {t('settings.doh.add')}
                </Button>
              </div>
              <div className="settings-notice-compact">
                <Icon name="info" size={14} />
                <span>{t('settings.doh.customHint')}</span>
              </div>
            </div>
          </div>
        )}

        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.doh.note')}</span>
        </div>
      </SettingsCard>

      {/* ── 4. Logs ─────────────────────────────────────────────────────── */}
      <SettingsCard title={t('privacy.grp.logs')} icon="file-text">
        <SettingRow
          icon="file-text"
          label={t('privacy.sanitizeLogs')}
          description={t('privacy.sanitizeLogs.desc')}
          control={
            <Toggle
              checked={config.sanitizeLogs}
              onChange={(val) => setCfg('sanitizeLogs', val)}
              ariaLabel={t('privacy.sanitizeLogs')}
            />
          }
        />
        <SettingRow
          icon="x-circle"
          label={t('privacy.disableLogs')}
          description={t('privacy.disableLogs.desc')}
          control={
            <Toggle
              checked={config.disableLogs}
              onChange={(val) => setCfg('disableLogs', val)}
              ariaLabel={t('privacy.disableLogs')}
            />
          }
        />
        <SettingRow
          icon="folder-open"
          label={t('privacy.logs.open')}
          control={
            <Button variant="secondary" onClick={openLogs} icon={<Icon name="folder-open" size={15} />}>
              {t('privacy.logs.openBtn')}
            </Button>
          }
        />
        <SettingRow
          icon="trash"
          label={t('privacy.logs.clear')}
          control={
            <Button variant="secondary" onClick={clearLogs} icon={<Icon name="trash" size={15} />}>
              {t('settings.clear')}
            </Button>
          }
        />
      </SettingsCard>

      {/* ── 5. Danger zone ──────────────────────────────────────────────── */}
      <SettingsCard title={t('privacy.grp.dangerZone')} icon="alert-triangle">
        <SettingRow
          icon="alert-triangle"
          label={t('privacy.clearAll')}
          description={t('privacy.clearAll.desc')}
          control={
            <Button variant="danger" onClick={handleClearAllData} icon={<Icon name="trash" size={15} />}>
              {t('settings.clear')}
            </Button>
          }
        />
      </SettingsCard>
    </>
  );
};
