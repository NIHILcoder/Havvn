import React, { useEffect, useState } from 'react';
import type { SearchProvider } from '../../shared/types';
import type { SearchNetworkSettings } from '../../shared/provider-network';
import { useTranslation } from '../utils/i18nContext';
import './ProviderConnectionSettings.css';

export function ProviderConnectionSettings({ provider, onConnectionChange }: { provider: SearchProvider; onConnectionChange?: () => void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SearchNetworkSettings>({ profiles: [], access: {} });
  const [profileId, setProfileId] = useState('legacy');
  const [origins, setOrigins] = useState('');
  const [mirrors, setMirrors] = useState('');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8080');
  const [protocol, setProtocol] = useState<'http' | 'socks5'>('http');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lines = (value: string) => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const savedAccess = settings.access[provider.id];
  const dirty = profileId !== (savedAccess?.profileId ?? 'legacy') || (profileId !== 'legacy' && (
    JSON.stringify(lines(origins)) !== JSON.stringify(savedAccess?.origins ?? []) ||
    JSON.stringify(lines(mirrors)) !== JSON.stringify(savedAccess?.mirrors ?? [])));
  const refresh = async () => {
    const value = await window.api.search.getNetworkSettings();
    setSettings(value);
    setProfileId(value.access[provider.id]?.profileId ?? 'legacy');
    setOrigins((value.access[provider.id]?.origins ?? []).join('\n'));
    setMirrors((value.access[provider.id]?.mirrors ?? []).join('\n'));
  };
  useEffect(() => {
    let alive = true;
    window.api.search.getNetworkSettings().then(value => {
      if (!alive) return;
      setSettings(value);
      setProfileId(value.access[provider.id]?.profileId ?? 'legacy');
      setOrigins((value.access[provider.id]?.origins ?? []).join('\n'));
      setMirrors((value.access[provider.id]?.mirrors ?? []).join('\n'));
    }).catch(() => { if (alive) setError(t('search.connection.failed')); });
    return () => { alive = false; };
  }, [provider.id, t]);
  const save = async (check = false) => {
    setBusy(true); setMessage(''); setError('');
    try {
      if (profileId !== 'legacy') {
        if (provider.type === 'script' && !lines(mirrors).length && !lines(origins).length) {
          throw new Error(t('search.connection.addressRequired'));
        }
        for (const [values, originOnly] of [[lines(mirrors), false], [lines(origins), true]] as const) {
          for (const value of values) {
            let url: URL;
            try { url = new URL(value); } catch { throw new Error(t('search.connection.invalidAddress')); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) {
              throw new Error(t('search.connection.invalidAddress'));
            }
          }
        }
      }
      let selected = profileId;
      if (selected === 'new') {
        const saved = await window.api.search.saveNetworkProfile({ name, connection: { mode: 'proxy', protocol, host: host.trim(), port: Number(port) } });
        selected = saved.id;
        setSettings(old => ({ ...old, profiles: [...old.profiles, saved] }));
        setProfileId(selected);
      }
      await window.api.search.setNetworkAccess(provider.id, selected === 'legacy' ? null : {
        profileId: selected, mirrors: lines(mirrors), origins: lines(origins),
      });
      onConnectionChange?.();
      if (check) {
        const result = await window.api.search.testProvider(provider.id);
        if (result.success) setMessage(t('search.connection.accessOk'));
        else setError(result.message);
      } else setMessage(t('search.connection.saved'));
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : t('search.connection.failed')); }
    finally { setBusy(false); }
  };
  const account = async (action: 'login' | 'logout' | 'check') => {
    setBusy(true); setMessage(''); setError('');
    try {
      if (action === 'logout') {
        await window.api.search.logout(provider.id);
        setMessage(t('search.connection.loggedOut'));
      } else {
        const result = action === 'login' ? await window.api.search.login(provider.id) : await window.api.search.testProvider(provider.id);
        if (result.success) setMessage(t('search.connection.accessOk'));
        else setError(result.message);
        await refresh();
      }
    } catch (e) { setError(e instanceof Error ? e.message : t('search.connection.failed')); }
    finally { setBusy(false); }
  };
  return <details onToggle={event => {
    if (event.currentTarget.open) void window.api.search.getNetworkSettings().then(setSettings).catch(() => setError(t('search.connection.failed')));
  }} className="provider-connection">
    <summary>{t('search.connection.title')}</summary>
    <fieldset disabled={busy} className="provider-connection-body">
    <p className="connection-hint">{t('search.connection.scope')}</p>
    <label className="connection-field">{t('search.connection.route')}
      <select className="form-select" value={profileId} onChange={e => setProfileId(e.target.value)} disabled={busy}>
        <option value="legacy">{t('search.connection.legacy')}</option>
        <option value="system">{t('search.connection.system')}</option>
        <option value="direct">{t('search.connection.direct')}</option>
        {settings.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value="new">{t('search.connection.new')}</option>
      </select>
    </label>
    {provider.type === 'script' && <p className="connection-hint">{t('search.connection.script')}</p>}
    {profileId === 'system' && <p className="connection-hint">{t('search.connection.systemHelp')}</p>}
    {profileId === 'new' && <div className="connection-proxy">
      <label className="connection-field">{t('search.connection.name')}<input className="form-input" placeholder={t('search.connection.name')} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="connection-field">{t('search.connection.protocol')}<select className="form-select" value={protocol} onChange={e => setProtocol(e.target.value as 'http' | 'socks5')}><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select></label>
      <label className="connection-field">{t('search.connection.host')}<input className="form-input" placeholder="127.0.0.1" value={host} onChange={e => setHost(e.target.value)} /></label>
      <label className="connection-field">{t('search.connection.port')}<input className="form-input" type="number" min={1} max={65535} value={port} onChange={e => setPort(e.target.value)} /></label>
      <p className="connection-hint">{t('search.connection.noAuth')}</p>
    </div>}
    {provider.type === 'script' && profileId !== 'legacy' && <label className="connection-field">{t('search.connection.mirrors')}
      <textarea className="form-input" disabled={busy} value={mirrors} onChange={e => setMirrors(e.target.value)} placeholder="https://rutracker.org/forum" rows={3} />
      <span className="connection-hint">{t('search.connection.mirrorsHelp')}</span>
    </label>}
    {profileId !== 'legacy' && <details className="connection-advanced"><summary>{t('search.connection.advanced')}</summary><label className="connection-field">{t('search.connection.origins')}
      <textarea className="form-input" value={origins} onChange={e => setOrigins(e.target.value)} placeholder="https://example.org" rows={3} />
      <span className="connection-hint">{t('search.connection.originsHelp')}</span>
    </label></details>}
    {savedAccess?.lastWorkingMirror && <p className="connection-hint">{t('search.connection.workingMirror')}: {savedAccess.lastWorkingMirror}</p>}
    <div className="connection-footer">
    {dirty && <p className="connection-hint" role="status">{t('search.connection.unsaved')}</p>}
    <div className="connection-actions">
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => save()}>{busy ? '…' : t('search.connection.save')}</button>
    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(true)}>{t('search.connection.saveCheck')}</button>
    </div>
    </div>
    {settings.access[provider.id] && <div className="connection-account">
      <p className="connection-hint">{t('search.connection.loginHelp')}</p>
      <div className="connection-actions">
      <button type="button" className="btn btn-secondary" disabled={busy || dirty} onClick={() => account('login')}>{t('search.connection.login')}</button>
      <button type="button" className="btn btn-secondary" disabled={busy || dirty} onClick={() => account('check')}>{t('search.connection.check')}</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => account('logout')}>{t('search.connection.logout')}</button>
      </div>
    </div>}
    {message && <p className="connection-feedback success" role="status">{message}</p>}
    {error && <p className="connection-feedback error" role="alert">{error}</p>}
    </fieldset>
  </details>;
}
