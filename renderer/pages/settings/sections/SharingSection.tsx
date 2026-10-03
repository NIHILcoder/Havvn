import { RoomBackupModal } from '../../rooms/RoomBackupModal';
/**
 * Sharing settings section (NEW tab) — ported from the old SettingsPage
 * monolith:
 *  - Mobile web remote (enable toggle + QR / URL / copy / regen) from
 *    renderNetworkSettings().
 *  - Share-link TURN relay (auto-saving toggle + custom TURN relay fields)
 *    from renderNetworkSettings().
 *  - Smart network profiles (enable toggle + current-network card + profile
 *    list / draft editor) from renderNetworkProfilesSection().
 * Specialized widgets (web-remote panel, np-* profile cards/editor) keep their
 * original classNames — their styles stay in SettingsPage.css.
 */
import React from 'react';
import { readRoomResources } from '../../../../shared/room-resources';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, TextField, NumberField } from '../controls';
import { Toggle, Button, Icon, QRCode } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { NetworkProfile } from '../../../../shared/types';
import { parseTrackers, hasOnlyInvalidTrackers, MAX_CUSTOM_TRACKERS } from '../../../../shared/trackers';

export const SharingSection: React.FC = () => {
  const { t } = useTranslation();
  const ctx = useSettings();
  const {
    webRemote, setWebRemote, remoteCopied, setRemoteCopied,
    shareUseTurn, setShareUseTurn, applyToggle,
    turnUrl, setTurnUrl, turnUser, setTurnUser, turnCred, setTurnCred, turnSaving, saveTurn,
    customTrackers, setCustomTrackers, trackersSaving, saveCustomTrackers,
    netEnabled, setNetEnabled, netProfiles, netCurrent, netActiveId,
    netDraft, setNetDraft, saveCurrentAsProfile, saveNetDraft,
    removeNetProfile, toggleOverride, setOverrideValue,
    setMessage,
  } = ctx;

  const [resources, setResources] = React.useState(() => readRoomResources(ctx.settings?.roomResources));
  const [resourceSaving, setResourceSaving] = React.useState(false);
  React.useEffect(() => { setResources(readRoomResources(ctx.settings?.roomResources)); }, [ctx.settings?.roomResources]);
  const saveResources = async () => {
    setResourceSaving(true);
    try {
      const result = await window.api.rooms.setResources(resources);
      ctx.setSettings(prev => prev ? { ...prev, roomResources: result.policy } : prev);
      setMessage({ type: result.error ? 'error' : 'success', text: result.error
        ? t('settings.roomResources.failed') + ': ' + result.error
        : t(result.applied ? 'settings.roomResources.applied' : 'settings.roomResources.saved') });
    } catch (error) {
      setMessage({ type: 'error', text: t('settings.roomResources.failed') + ': ' + String(error) });
    } finally { setResourceSaving(false); }
  };

  // ── Room identity backup (reinstall insurance) ────────────────────────────
  const [identityMode, setIdentityMode] = React.useState<'export' | 'import' | null>(null);

  // ── Network-profile helpers (ported verbatim from the old monolith) ───────
  const overrideSummary = (p: NetworkProfile): string => {
    const o = p.overrides; const parts: string[] = [];
    if (o.maxDownKbps !== undefined) parts.push(`↓ ${o.maxDownKbps || '∞'}`);
    if (o.maxUpKbps !== undefined) parts.push(`↑ ${o.maxUpKbps || '∞'}`);
    if (o.maxConnectionsGlobal !== undefined) parts.push(`${o.maxConnectionsGlobal} ${t('settings.net.connShort')}`);
    if (o.adaptiveUpload !== undefined) parts.push(`${t('settings.net.adaptiveShort')} ${o.adaptiveUpload ? t('swarm.on') : t('swarm.off')}`);
    if (o.dohEnabled !== undefined) parts.push(`DoH ${o.dohEnabled ? t('swarm.on') : t('swarm.off')}`);
    return parts.length ? parts.join(' · ') : t('settings.net.noOverrides');
  };

  const numRow = (key: 'maxDownKbps' | 'maxUpKbps' | 'maxConnectionsGlobal', label: string, unit: string) => {
    const o = netDraft!.overrides; const on = o[key] !== undefined;
    return (
      <div className="np-ovr">
        <label className="np-ovr-toggle">
          <input type="checkbox" checked={on} onChange={(e) => toggleOverride(key, e.target.checked)} /> {label}
        </label>
        {on && (
          <div className="speed-input-compact">
            <NumberField min={0} value={o[key] as number} unit={unit} ariaLabel={label}
              onChange={(value) => setOverrideValue(key, Math.trunc(value) || 0)} />
          </div>
        )}
      </div>
    );
  };

  const boolRow = (key: 'adaptiveUpload' | 'dohEnabled', label: string) => {
    const o = netDraft!.overrides; const on = o[key] !== undefined;
    return (
      <div className="np-ovr">
        <label className="np-ovr-toggle">
          <input type="checkbox" checked={on} onChange={(e) => toggleOverride(key, e.target.checked)} /> {label}
        </label>
        {on && <Toggle checked={!!o[key]} onChange={() => setOverrideValue(key, !o[key])} ariaLabel={label} />}
      </div>
    );
  };

  const editor = () => (
    <div className="np-editor">
      <input className="input-compact np-name" value={netDraft!.name}
        onChange={(e) => setNetDraft((d) => (d ? { ...d, name: e.target.value } : d))}
        placeholder={t('settings.net.namePlaceholder')} />
      <div className="np-bound">{t('settings.net.boundTo')}: <strong>{netDraft!.networkLabel || netDraft!.networkKey || '—'}</strong></div>
      {numRow('maxDownKbps', t('settings.downSpeed'), 'KB/s')}
      {numRow('maxUpKbps', t('settings.upSpeed'), 'KB/s')}
      {numRow('maxConnectionsGlobal', t('settings.maxConnGlobal'), '')}
      {boolRow('adaptiveUpload', t('settings.adaptiveUpload'))}
      {boolRow('dohEnabled', t('settings.doh'))}
      <div className="np-editor-actions">
        <Button variant="ghost" size="sm" onClick={() => setNetDraft(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={saveNetDraft}>{t('common.save')}</Button>
      </div>
    </div>
  );

  return (
    <>
      {/* ── Mobile web remote ────────────────────────────────────────────── */}
      <SettingsCard title={t('settings.card.webRemote')} icon="qr-code">
        <SettingRow
          label={t('settings.webRemote')}
          description={t('settings.webRemote.desc')}
          control={
            <Toggle
              checked={webRemote.enabled}
              onChange={async () => {
                const info = await window.api.webRemote.setEnabled(!webRemote.enabled);
                setWebRemote(info);
              }}
            />
          }
        />

        {webRemote.enabled && webRemote.url && (
          <div className="web-remote-panel">
            <div className="web-remote-qr"><QRCode data={webRemote.url} size={168} /></div>
            <div className="web-remote-info">
              <p className="web-remote-hint">{t('settings.webRemote.scan')}</p>
              <div className="web-remote-url">{webRemote.url}</div>
              <div className="web-remote-actions">
                <Button variant="secondary" size="sm" icon={<Icon name={remoteCopied ? 'check' : 'copy'} size={14} />}
                  onClick={async () => { try { await navigator.clipboard.writeText(webRemote.url!); setRemoteCopied(true); setTimeout(() => setRemoteCopied(false), 1500); } catch { /* ignore */ } }}>
                  {t('settings.webRemote.copy')}
                </Button>
                <Button variant="ghost" size="sm" icon={<Icon name="refresh-cw" size={14} />}
                  onClick={async () => { const info = await window.api.webRemote.regenToken(); setWebRemote(info); }}>
                  {t('settings.webRemote.regen')}
                </Button>
              </div>
            </div>
          </div>
        )}
        {webRemote.enabled && !webRemote.url && (
          <div className="settings-notice-compact">
            <Icon name="alert-triangle" size={14} />
            <span>{t('settings.webRemote.noLan')}</span>
          </div>
        )}
        <div className="settings-notice-compact web-remote-warn">
          <Icon name="alert-triangle" size={14} />
          <span>{t('settings.webRemote.warn')}</span>
        </div>
      </SettingsCard>

      {/* ── TURN relay for share links ───────────────────────────────────── */}
      <SettingsCard title={t('settings.card.turnRelay')} icon="server">
        <SettingRow
          label={t('settings.shareTurn')}
          description={t('settings.shareTurn.desc')}
          control={
            <Toggle
              checked={shareUseTurn}
              onChange={() => applyToggle(!shareUseTurn, setShareUseTurn, { shareUseTurn: !shareUseTurn })}
            />
          }
        />
        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.shareTurn.note')}</span>
        </div>

        {/* Optional user-supplied TURN relay (zero-cost ladder, last resort).
            Three inputs + a button never fit the row's control column — this is
            a stacked full-width block: label/description on top, fields below. */}
        <div className="stg-sub">
          <div className="stg-row-label">{t('settings.customTurn.title')}</div>
          <p className="stg-row-desc stg-row-desc-wide">{t('settings.customTurn.note')}</p>
          <div className="stg-fields">
            <TextField
              mono
              value={turnUrl}
              onChange={setTurnUrl}
              placeholder="turn:relay.example.com:3478"
            />
            <TextField
              value={turnUser}
              onChange={setTurnUser}
              placeholder={t('settings.customTurn.user')}
            />
            <input
              className="stg-text"
              type="password"
              value={turnCred}
              placeholder={t('settings.customTurn.pass')}
              aria-label={t('settings.customTurn.pass')}
              onChange={(e) => setTurnCred(e.target.value)}
            />
            <Button variant="secondary" size="sm" onClick={saveTurn} loading={turnSaving} icon={<Icon name="check" size={14} />}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        {/* Own rendezvous trackers. Same stacked full-width shape as the TURN
            block. The live count matters here: invalid entries are dropped on
            save, so without it a typo would look like it took effect while
            rooms silently kept announcing to the public defaults. */}
        <div className="stg-sub">
          <div className="stg-row-label">{t('settings.customTrackers.title')}</div>
          <p className="stg-row-desc stg-row-desc-wide">{t('settings.customTrackers.note')}</p>
          <div className="stg-fields">
            <TextField
              mono
              value={customTrackers}
              onChange={setCustomTrackers}
              placeholder="wss://tracker.example.com, wss://tracker2.example.com"
            />
            <Button variant="secondary" size="sm" onClick={saveCustomTrackers} loading={trackersSaving} icon={<Icon name="check" size={14} />}>
              {t('common.save')}
            </Button>
          </div>
          {hasOnlyInvalidTrackers(customTrackers) ? (
            <div className="settings-notice-compact">
              <Icon name="info" size={14} />
              <span>{t('settings.customTrackers.invalid')}</span>
            </div>
          ) : parseTrackers(customTrackers).length > 0 ? (
            <div className="settings-notice-compact">
              <Icon name="info" size={14} />
              <span>
                {t('settings.customTrackers.count')
                  .replace('{n}', String(parseTrackers(customTrackers).length))
                  .replace('{max}', String(MAX_CUSTOM_TRACKERS))}
              </span>
            </div>
          ) : null}
        </div>
      </SettingsCard>

      {/* ── Room identity backup ─────────────────────────────────────────── */}
      <SettingsCard title={t('settings.roomResources.title')} icon="download" description={t('settings.roomResources.scope')}>
        <SettingRow label={t('settings.roomResources.upload')} description={t('settings.roomResources.shared')}
          control={<NumberField value={resources.maxUpKbps} min={0} max={1000000} unit="KB/s" ariaLabel={t('settings.roomResources.upload')}
            onChange={value => setResources(prev => ({ ...prev, maxUpKbps: value }))} />} />
        <SettingRow label={t('settings.roomResources.download')} description={t('settings.roomResources.zero')}
          control={<NumberField value={resources.maxDownKbps} min={0} max={1000000} unit="KB/s" ariaLabel={t('settings.roomResources.download')}
            onChange={value => setResources(prev => ({ ...prev, maxDownKbps: value }))} />} />
        <SettingRow label={t('settings.roomResources.voice')} description={t('settings.roomResources.voiceHint')}
          control={<Toggle checked={resources.voicePriority} disabled={resourceSaving}
            onChange={value => setResources(prev => ({ ...prev, voicePriority: value }))} />} />
        <SettingRow label={t('settings.roomResources.screen')} description={t('settings.roomResources.screenHint')}
          control={<NumberField value={resources.screenBitrateKbps} min={250} max={20000} step={250} unit="kbit/s" ariaLabel={t('settings.roomResources.screen')}
            onChange={value => setResources(prev => ({ ...prev, screenBitrateKbps: value }))} />} />
        <div className="stg-sub"><Button variant="primary" size="sm" loading={resourceSaving} onClick={saveResources}>{t('common.save')}</Button></div>
      </SettingsCard>

      {identityMode && <RoomBackupModal mode={identityMode} onClose={() => setIdentityMode(null)} onDone={rooms => setMessage({ type: 'success', text: t(rooms === undefined ? 'settings.roomIdentity.exported' : 'settings.roomIdentity.imported') })} />}
      <SettingsCard title={t('settings.card.roomIdentity')} icon="shield">
        <SettingRow
          label={t('settings.roomIdentity.export')}
          description={t('settings.roomIdentity.export.desc')}
          control={
            <Button variant="secondary" size="sm"
              icon={<Icon name="upload" size={14} />} onClick={() => setIdentityMode('export')}>
              {t('settings.roomIdentity.exportBtn')}
            </Button>
          }
        />
        <SettingRow
          label={t('settings.roomIdentity.import')}
          description={t('settings.roomIdentity.import.desc')}
          control={
            <Button variant="secondary" size="sm"
              icon={<Icon name="download" size={14} />} onClick={() => setIdentityMode('import')}>
              {t('settings.roomIdentity.importBtn')}
            </Button>
          }
        />
        <div className="settings-notice-compact web-remote-warn">
          <Icon name="alert-triangle" size={14} />
          <span>{t('settings.roomIdentity.warn')}</span>
        </div>
      </SettingsCard>

      {/* ── Smart network profiles ───────────────────────────────────────── */}
      <SettingsCard title={t('settings.card.netProfiles')} icon="network">
        <SettingRow
          label={t('settings.net')}
          description={t('settings.net.desc')}
          control={
            <Toggle
              checked={netEnabled}
              onChange={() => applyToggle(!netEnabled, setNetEnabled, { networkProfilesEnabled: !netEnabled })}
            />
          }
        />

        {netEnabled && (
          <div className="np-panel">
            <div className="np-current">
              <Icon name="network" size={16} />
              <div className="np-current-info">
                <div className="np-current-label">{netCurrent?.label || t('settings.net.detecting')}</div>
                <div className="np-current-sub">
                  {netCurrent?.key
                    ? (netActiveId ? `${t('settings.net.active')}: ${netProfiles.find((p) => p.id === netActiveId)?.name || ''}` : t('settings.net.baseActive'))
                    : t('settings.net.undetectable')}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={saveCurrentAsProfile}
                disabled={!netCurrent?.key || netProfiles.some((p) => p.networkKey === netCurrent?.key)}
                icon={<Icon name="plus" size={14} />}>
                {t('settings.net.saveCurrent')}
              </Button>
            </div>

            {netProfiles.length === 0 && !netDraft ? (
              <div className="np-empty">{t('settings.net.empty')}</div>
            ) : (
              <div className="np-list">
                {netProfiles.map((p) => {
                  const isCurrent = !!netCurrent?.key && p.networkKey === netCurrent.key;
                  const isActive = p.id === netActiveId;
                  return (
                    <div key={p.id} className={`np-item ${isActive ? 'active' : ''}`}>
                      <div className="np-item-head">
                        <span className="np-item-name">{p.name}{isCurrent && <span className="np-here">{t('settings.net.here')}</span>}</span>
                        <span className="np-item-summary">{overrideSummary(p)}</span>
                        <div className="np-item-actions">
                          <button className="doh-mini-btn" onClick={() => setNetDraft(netDraft?.id === p.id ? null : { ...p })} title={t('common.edit')}><Icon name="settings" size={13} /></button>
                          <button className="doh-mini-btn danger" onClick={() => removeNetProfile(p.id)} title={t('settings.doh.delete')}><Icon name="trash" size={13} /></button>
                        </div>
                      </div>
                      {netDraft?.id === p.id && editor()}
                    </div>
                  );
                })}
                {netDraft && !netDraft.id && <div className="np-item active">{editor()}</div>}
              </div>
            )}

            <div className="settings-notice-compact"><Icon name="info" size={14} /><span>{t('settings.net.note')}</span></div>
          </div>
        )}
      </SettingsCard>
    </>
  );
};
