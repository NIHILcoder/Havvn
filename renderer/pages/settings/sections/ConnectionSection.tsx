/**
 * Settings → Connection section (new card-based layout).
 *
 * Merges the old Network + Advanced tabs: global/alt speed limits and the
 * adaptive upload throttle (with its live health widget) from
 * renderNetworkSettings(), plus protocols (DHT/µTP), connection caps and the
 * listening port + UPnP forwarding (with its status pill) from
 * renderAdvancedSettings(). DoH, network profiles, TURN and the web remote
 * live in other sections. Specialized widgets (adaptive health bar, pf status
 * pill) keep their original markup/classes — styled by SettingsPage.css.
 */

import React from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, NumberField, RestartPendingNotice, TextField } from '../controls';
import { Icon, Toggle, Select } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';

export const ConnectionSection: React.FC = () => {
  const { t } = useTranslation();
  const {
    applyToggle,
    engine, runningEngine,
    maxDownKbps, setMaxDownKbps, maxUpKbps, setMaxUpKbps,
    adaptiveUpload, setAdaptiveUpload, netHealth,
    altSpeedEnabled, setAltSpeedEnabled,
    altDownKbps, setAltDownKbps, altUpKbps, setAltUpKbps,
    enableDHT, setEnableDHT, enableUtp, setEnableUtp, transportRestartPending,
    encryption, setEncryption, setSettings, loadSettings,
    maxConnections, setMaxConnections,
    maxConnectionsGlobal, setMaxConnectionsGlobal,
    portMin, setPortMin,
    portForwarding, setPortForwarding, pfStatus,
    proxyEnabled, setProxyEnabled, proxyType, setProxyType,
    proxyHost, setProxyHost, proxyPort, setProxyPort,
    proxyUsername, setProxyUsername, proxyPassword, setProxyPassword,
    proxyRestartPending, setProxyRestartPending,
  } = useSettings();
  const tk = (k: string) => t(k as Parameters<typeof t>[0]);

  // Coloured status pill for UPnP port forwarding — markup kept from the old
  // renderPfStatus() (styles in SettingsPage.css).
  const renderPfStatus = () => {
    const st = pfStatus?.state ?? 'mapping';
    const portTxt = pfStatus?.port ? ` (${pfStatus.port})` : '';
    const map: Record<string, { cls: string; icon: 'check-circle' | 'alert-triangle' | 'x-circle' | 'loader'; key: string }> = {
      mapped:      { cls: 'on',  icon: 'check-circle',   key: 'settings.pf.mapped' },
      mapping:     { cls: 'off', icon: 'loader',         key: 'settings.pf.mapping' },
      unsupported: { cls: 'off', icon: 'alert-triangle', key: 'settings.pf.unsupported' },
      failed:      { cls: 'off', icon: 'x-circle',       key: 'settings.pf.failed' },
      disabled:    { cls: 'off', icon: 'x-circle',       key: 'settings.pf.disabled' },
    };
    const m = map[st] ?? map.mapping;
    return (
      <span
        className={`privacy-status ${m.cls}`}
        title={pfStatus?.error || (pfStatus?.externalIp ? `${t('settings.pf.externalIp')}: ${pfStatus.externalIp}` : '')}
      >
        <Icon name={m.icon} size={14} /> {tk(m.key)}{portTxt}
      </span>
    );
  };

  // Live indicator for the adaptive upload throttle: shows the control loop's
  // current latency vs its unloaded baseline, the cap it has settled on, and
  // the upload rate flowing through it — markup kept from the old
  // renderAdaptiveHealth() (styles in SettingsPage.css).
  const renderAdaptiveHealth = () => {
    const a = netHealth?.adaptive;
    const fmtSpeed = (bps: number): string => {
      if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
      if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
      return `${Math.round(bps)} B/s`;
    };

    // Pill state: measuring → easing (congested) → tuning (capped, clear) → clear.
    let cls = 'off', icon: 'loader' | 'alert-triangle' | 'activity' | 'check-circle' = 'loader', key = 'settings.adaptive.state.measuring';
    if (a && a.latencyMs != null) {
      if (a.congested) { cls = 'warn'; icon = 'alert-triangle'; key = 'settings.adaptive.state.easing'; }
      else if (a.capKbps > 0) { cls = 'on'; icon = 'activity'; key = 'settings.adaptive.state.tuning'; }
      else { cls = 'on'; icon = 'check-circle'; key = 'settings.adaptive.state.clear'; }
    }

    // Latency bar: fill grows with latency relative to a 3× baseline span; a
    // marker sits at the baseline so congestion (fill past the marker) is visible.
    const base = a?.baselineMs ?? null;
    const lat = a?.latencyMs ?? null;
    const span = base && base > 0 ? base * 3 : 150;
    const fillPct = lat != null ? Math.min(100, Math.round((lat / span) * 100)) : 0;
    const basePct = base && base > 0 ? Math.min(100, Math.round((base / span) * 100)) : 33;

    return (
      <div className="adaptive-health">
        <div className="adaptive-health-head">
          <span className={`privacy-status ${cls}`}>
            <Icon name={icon} size={14} /> {tk(key)}
          </span>
          <span className="adaptive-health-cap">
            {a && a.capKbps > 0 ? `${a.capKbps} KB/s` : t('settings.adaptive.unlimited')}
          </span>
        </div>
        <div className="adaptive-bar" title={t('settings.adaptive.latency')}>
          <div className={`adaptive-bar-fill ${a?.congested ? 'congested' : ''}`} style={{ width: `${fillPct}%` }} />
          <div className="adaptive-bar-marker" style={{ left: `${basePct}%` }} />
        </div>
        <div className="adaptive-health-metrics">
          <span>{t('settings.adaptive.latency')}: <strong>{lat != null ? `${lat} ms` : '—'}</strong>{base != null ? ` / ${base} ms` : ''}</span>
          <span>{t('settings.adaptive.upload')}: <strong>{netHealth ? fmtSpeed(netHealth.uploadBps) : '—'}</strong></span>
        </div>
      </div>
    );
  };

  return (
    <>
      <SettingsCard title={t('settings.grp.speedLimits')} icon="gauge">
        <SettingRow
          label={t('settings.downSpeed')}
          description={t('settings.downSpeed.desc')}
          control={
            <NumberField
              value={maxDownKbps}
              onChange={(v) => setMaxDownKbps(Math.round(v))}
              unit="KB/s"
              min={0}
              ariaLabel={t('settings.downSpeed')}
            />
          }
        />
        <SettingRow
          label={t('settings.upSpeed')}
          description={t('settings.upSpeed.desc')}
          control={
            <NumberField
              value={maxUpKbps}
              onChange={(v) => setMaxUpKbps(Math.round(v))}
              unit="KB/s"
              min={0}
              ariaLabel={t('settings.upSpeed')}
            />
          }
        />

        {/* Honesty note: only the Classic (WebTorrent) engine approximates
            limits — the native daemon enforces them for real. Gated on the
            engine actually RUNNING right now. */}
        {(runningEngine ?? engine) === 'webtorrent' && (
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.speedNote')}</span>
          </div>
        )}

        {/* Adaptive upload throttle — "smart" limit that needs no manual KB/s. */}
        <SettingRow
          label={t('settings.adaptiveUpload')}
          description={t('settings.adaptiveUpload.desc')}
          control={
            <Toggle
              checked={adaptiveUpload}
              onChange={(v) => applyToggle(v, setAdaptiveUpload, { adaptiveUpload: v })}
              ariaLabel={t('settings.adaptiveUpload')}
            />
          }
        />
        {adaptiveUpload && renderAdaptiveHealth()}
        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.adaptiveUpload.note')}</span>
        </div>

        {/* Alternative ("turbo"/turtle) speed limits */}
        <SettingRow
          label={t('settings.altSpeed')}
          description={t('settings.altSpeed.desc')}
          control={
            <Toggle
              checked={altSpeedEnabled}
              onChange={(v) =>
                applyToggle(v, setAltSpeedEnabled, { altSpeedEnabled: v }, (val) => window.api.setAltSpeed(val))
              }
              ariaLabel={t('settings.altSpeed')}
            />
          }
        />
        <SettingRow
          label={t('settings.altDown')}
          description={t('settings.altDown.desc')}
          control={
            <NumberField
              value={altDownKbps}
              onChange={(v) => setAltDownKbps(Math.round(v))}
              unit="KB/s"
              min={0}
              ariaLabel={t('settings.altDown')}
            />
          }
        />
        <SettingRow
          label={t('settings.altUp')}
          description={t('settings.altUp.desc')}
          control={
            <NumberField
              value={altUpKbps}
              onChange={(v) => setAltUpKbps(Math.round(v))}
              unit="KB/s"
              min={0}
              ariaLabel={t('settings.altUp')}
            />
          }
        />
        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.altSpeed.note')}</span>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.grp.connections')} icon="network">
        <SettingRow
          label={t('settings.dht')}
          description={t('settings.dht.desc')}
          control={
            <Toggle
              checked={enableDHT}
              onChange={(v) => applyToggle(v, setEnableDHT, { enableDHT: v })}
              ariaLabel={t('settings.dht')}
            />
          }
        />
        <SettingRow
          label={t('settings.utp')}
          description={t('settings.utp.desc')}
          control={
            <Toggle
              checked={enableUtp}
              onChange={(v) => applyToggle(v, setEnableUtp, { enableUtp: v })}
              ariaLabel={t('settings.utp')}
            />
          }
        />
        <SettingRow
          label={t('settings.encryption')}
          description={t('settings.encryption.desc')}
          control={
            <div style={{ width: 180 }}>
              <Select
                options={[
                  { value: 'required', label: t('settings.encryption.required') },
                  { value: 'preferred', label: t('settings.encryption.preferred') },
                  { value: 'tolerated', label: t('settings.encryption.tolerated') },
                ]}
                value={encryption}
                onChange={async (v) => {
                  const next = v === 'required' || v === 'tolerated' ? v : 'preferred';
                  setEncryption(next);
                  setSettings((prev) => (prev ? { ...prev, encryption: next } : prev));
                  try { await window.api.updateSettings({ encryption: next }); }
                  catch { await loadSettings(); }
                }}
              />
            </div>
          }
        />
        {(runningEngine ?? engine) === 'webtorrent' && (
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.encryption.nativeOnly')}</span>
          </div>
        )}
        {/* PEX/LSD toggles removed: WebTorrent can't switch PEX off and has
            no LSD implementation — the switches were placebo. */}
        {/* The native engine pushes these over RPC and applies them at once, so
            transportRestartPending is false there and this stays the plain note.
            Only the webtorrent client, which fixes utp/dht in its constructor,
            can owe a restart — and then it says so rather than looking applied. */}
        {transportRestartPending ? (
          <RestartPendingNotice text={t('settings.protocols.pending')} />
        ) : (
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.protocols.note')}</span>
          </div>
        )}

        <SettingRow
          label={t('settings.maxConn')}
          description={t('settings.maxConn.desc')}
          control={
            <NumberField
              value={maxConnections}
              onChange={(v) => setMaxConnections(Math.round(v) || 55)}
              min={10}
              max={500}
              ariaLabel={t('settings.maxConn')}
            />
          }
        />
        <SettingRow
          label={t('settings.maxConnGlobal')}
          description={t('settings.maxConnGlobal.desc')}
          control={
            <NumberField
              value={maxConnectionsGlobal}
              onChange={(v) => setMaxConnectionsGlobal(Math.round(v) || 200)}
              min={20}
              max={2000}
              ariaLabel={t('settings.maxConnGlobal')}
            />
          }
        />
      </SettingsCard>

      <SettingsCard title={t('settings.grp.ports')} icon="server">
        {/* WebTorrent listens on ONE port, not a range — a single field
            (persisted as portMin for backwards compatibility). */}
        <SettingRow
          label={t('settings.port')}
          description={t('settings.port.desc')}
          control={
            <NumberField
              value={portMin}
              onChange={(v) => setPortMin(Math.round(v) || 6881)}
              min={1024}
              max={65535}
              ariaLabel={t('settings.port')}
            />
          }
        />
        <SettingRow
          label={t('settings.portForward')}
          description={t('settings.portForward.desc')}
          control={
            <Toggle
              checked={portForwarding}
              onChange={(v) => applyToggle(v, setPortForwarding, { portForwarding: v })}
              ariaLabel={t('settings.portForward')}
            />
          }
        />
        {portForwarding && (
          <SettingRow
            label={t('settings.portForward.status')}
            description={t('settings.portForward.statusDesc')}
            control={renderPfStatus()}
          />
        )}

        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.advanced.restartNote')}</span>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.grp.proxy')} icon="globe">
        <SettingRow
          label={t('settings.proxyEnable')}
          description={t('settings.proxyEnable.desc')}
          control={
            <Toggle
              checked={proxyEnabled}
              onChange={(v) => {
                setProxyRestartPending(true);
                void applyToggle(v, setProxyEnabled, { proxyEnabled: v });
              }}
              ariaLabel={t('settings.proxyEnable')}
            />
          }
        />
        {proxyEnabled && (
          <>
            <SettingRow
              label={t('settings.proxyType')}
              description={t('settings.proxyType.desc')}
              control={
                <div style={{ width: 150 }}>
                  <Select
                    options={[
                      { value: 'http', label: 'HTTP' },
                      { value: 'https', label: 'HTTPS' },
                      { value: 'socks5', label: 'SOCKS5' },
                    ]}
                    value={proxyType}
                    onChange={(v) => setProxyType(v === 'https' || v === 'socks5' ? v : 'http')}
                  />
                </div>
              }
            />
            <SettingRow
              label={t('settings.proxyHost')}
              description={t('settings.proxyHost.desc')}
              control={
                <TextField
                  value={proxyHost}
                  onChange={setProxyHost}
                  mono
                  ariaLabel={t('settings.proxyHost')}
                />
              }
            />
            <SettingRow
              label={t('settings.proxyPort')}
              description={t('settings.proxyPort.desc')}
              control={
                <NumberField
                  value={proxyPort}
                  onChange={(v) => setProxyPort(Math.round(v) || 0)}
                  min={1}
                  max={65535}
                  ariaLabel={t('settings.proxyPort')}
                />
              }
            />
            <SettingRow
              label={t('settings.proxyUser')}
              description={t('settings.proxyUser.desc')}
              control={
                <TextField
                  value={proxyUsername}
                  onChange={setProxyUsername}
                  ariaLabel={t('settings.proxyUser')}
                />
              }
            />
            <SettingRow
              label={t('settings.proxyPass')}
              description={t('settings.proxyPass.desc')}
              control={
                <input
                  className="stg-text"
                  type="password"
                  value={proxyPassword}
                  aria-label={t('settings.proxyPass')}
                  onChange={(e) => setProxyPassword(e.target.value)}
                />
              }
            />
          </>
        )}
        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.proxyNote')}</span>
        </div>
        {proxyRestartPending && <RestartPendingNotice text={t('settings.proxy.pending')} />}
      </SettingsCard>
    </>
  );
};
