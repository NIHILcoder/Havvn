/**
 * Settings controller — ALL settings state, loading, and save logic in one
 * provider; section components consume it via useSettings().
 *
 * Toggles and instant choices serialize their writes and roll back one field.
 * Save-bar fields commit a snapshot, preserving edits made while it is pending.
 * TURN and other blocks with their own Save button are saved separately.
 */
import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import {
  AppSettings, SchedulerConfig, ScheduleEntry, PortForwardStatus, NetworkHealth,
  DohTemplate, NetworkProfile, NetworkInfo, RunningTransport,
} from '../../../shared/types';
import { parseTrackers } from '../../../shared/trackers';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../../utils/i18nContext';
import { getActiveTheme, applyThemeObject } from '../../utils/theme-library';
import { restoreThemePrefs } from '../../utils/theme-prefs';
import { useThemeEditor } from '../../components/ThemeEditorContext';
import { TRANSFER_SECTIONS, type TransferSection, type SettingsTransferStatus } from '../../../shared/interface-preferences';
import { useSettingsExportOperation } from '../../state/settings-export';
import { useEngineCapabilities } from '../../utils/useEngineCapabilities';
import { isOperationActive } from '../../../shared/operations';
import { WORKING_PROFILE_EVENT } from '../../utils/working-profiles';

export type Theme = 'light' | 'dark' | 'system';

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
function useSettingsController() {
  const { t, language } = useTranslation();
  // While the theme editor is open it OWNS :root (its live draft preview). Settings
  // must not re-apply the saved active theme over it, or an unsaved change — e.g. a
  // Roundness value being previewed — gets wiped when you open Settings.
  const { open: themeEditorOpen } = useThemeEditor();

  const [activeCategory, setActiveCategory] = useState('general');

  // App version + update state
  const [appVersion, setAppVersion] = useState('');
  const [updateReady, setUpdateReady] = useState<string | null>(null);

  // Settings load/save state
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [instantSaving, setInstantSaving] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const toggleRevision = useRef(new Map<keyof AppSettings, number>());
  const instantQueue = useRef(Promise.resolve());
  const savePending = useRef(false);
  const watchRevision = useRef(0);
  const [selectedTransferSections, setSelectedTransferSections] = useState<TransferSection[]>([...TRANSFER_SECTIONS]);
  const [transferPending, setTransferBusy] = useState(false);
  const exportObservation = useSettingsExportOperation();
  const transferBusy = transferPending || isOperationActive(exportObservation.operation);
  const [transferStatus, setTransferStatus] = useState<SettingsTransferStatus>({ backupAt: null, recoveryNeeded: false });
  const refreshTransferStatus = async () => {
    const next = await window.api.getSettingsTransferStatus?.();
    if (next) setTransferStatus(next);
    window.dispatchEvent(new Event('havvn:settings-transfer'));
  };
  useEffect(() => { void refreshTransferStatus().catch(() => {}); }, []);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.api.getSettingsTransferStatus?.().then(status => { if (alive && status) setTransferStatus(status); }).catch(() => {});
    };
    window.addEventListener('havvn:settings-transfer', refresh);
    return () => { alive = false; window.removeEventListener('havvn:settings-transfer', refresh); };
  }, []);

  // General
  const [defaultDownloadDir, setDefaultDownloadDir] = useState('');
  const [theme, setTheme] = useState<Theme>('system');
  const [engine, setEngineState] = useState<'native' | 'webtorrent'>('native');
  const [runningEngine, setRunningEngine] = useState<'native' | 'webtorrent' | null>(null);
  const { capabilities: engineCapabilities, failed: engineCapabilitiesFailed } = useEngineCapabilities();
  // What the running engine was BUILT with. Null on the native engine, which
  // applies every transport toggle live — so it never shows a restart notice.
  const [runningTransport, setRunningTransport] = useState<RunningTransport | null>(null);

  // Notifications
  const [enableNotifications, setEnableNotifications] = useState(true);
  const [enableSounds, setEnableSounds] = useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [notifyOnError, setNotifyOnError] = useState(true);

  // System
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [isDefaultClient, setIsDefaultClient] = useState(false);

  // Network / connection
  const [maxDownKbps, setMaxDownKbps] = useState(0);
  const [maxUpKbps, setMaxUpKbps] = useState(0);
  const [adaptiveUpload, setAdaptiveUpload] = useState(false);
  const [netHealth, setNetHealth] = useState<NetworkHealth | null>(null);
  // DNS-over-HTTPS
  const [dohEnabled, setDohEnabled] = useState(false);
  const [dohTemplateId, setDohTemplateId] = useState('cloudflare');
  const [dohTemplates, setDohTemplates] = useState<DohTemplate[]>([]);
  const [dohNewName, setDohNewName] = useState('');
  const [dohNewUrl, setDohNewUrl] = useState('');
  const [dohAdding, setDohAdding] = useState(false);
  const [dohTest, setDohTest] = useState<{ id: string; state: 'testing' | 'ok' | 'err'; text: string } | null>(null);
  // Smart network profiles
  const [netEnabled, setNetEnabled] = useState(false);
  const [netProfiles, setNetProfiles] = useState<NetworkProfile[]>([]);
  const [netCurrent, setNetCurrent] = useState<NetworkInfo | null>(null);
  const [netActiveId, setNetActiveId] = useState<string | null>(null);
  const [netDraft, setNetDraft] = useState<NetworkProfile | null>(null);
  const [maxActiveDownloads, setMaxActiveDownloads] = useState(3);
  // Alternative ("turbo") speed limits
  const [altSpeedEnabled, setAltSpeedEnabled] = useState(false);
  const [altDownKbps, setAltDownKbps] = useState(0);
  const [altUpKbps, setAltUpKbps] = useState(0);
  // Auto-move completed
  const [autoMoveEnabled, setAutoMoveEnabled] = useState(false);
  const [autoMovePath, setAutoMovePath] = useState('');
  // Mobile web remote
  const [webRemote, setWebRemote] = useState<{ enabled: boolean; running: boolean; url: string | null; port: number }>({ enabled: false, running: false, url: null, port: 0 });
  const [remoteCopied, setRemoteCopied] = useState(false);

  // Advanced (now part of Connection)
  const [enableDHT, setEnableDHT] = useState(true);
  const [enableUtp, setEnableUtp] = useState(false);
  const [encryption, setEncryption] = useState<'required' | 'preferred' | 'tolerated'>('preferred');
  const [maxConnections, setMaxConnections] = useState(55);
  const [maxConnectionsGlobal, setMaxConnectionsGlobal] = useState(200);
  const [portMin, setPortMin] = useState(6881);
  const [portForwarding, setPortForwarding] = useState(true);
  const [pfStatus, setPfStatus] = useState<PortForwardStatus | null>(null);

  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyType, setProxyType] = useState<'http' | 'https' | 'socks5'>('http');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState(8080);
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [proxyRestartPending, setProxyRestartPending] = useState(false);

  // Watch folder
  const [watchFolderEnabled, setWatchFolderEnabled] = useState(false);
  const [watchFolderPath, setWatchFolderPath] = useState('');
  const [watchFolderDeleteAfterAdd, setWatchFolderDeleteAfterAdd] = useState(false);

  // Clipboard magnet watcher (opt-in)
  const [clipboardWatchEnabled, setClipboardWatchEnabled] = useState(false);

  // Disk-space guard
  const [diskGuardEnabled, setDiskGuardEnabled] = useState(true);
  const [diskGuardMinFreeMB, setDiskGuardMinFreeMB] = useState(2048);

  // Sharing
  const [shareUseTurn, setShareUseTurn] = useState(true);
  const [turnUrl, setTurnUrl] = useState('');
  const [turnUser, setTurnUser] = useState('');
  const [turnCred, setTurnCred] = useState('');
  const [turnSaving, setTurnSaving] = useState(false);
  const [customTrackers, setCustomTrackers] = useState('');
  const [trackersSaving, setTrackersSaving] = useState(false);

  // Seeding limits
  const [defaultSeedRatioLimit, setDefaultSeedRatioLimit] = useState(0);
  const [defaultSeedTimeLimitMinutes, setDefaultSeedTimeLimitMinutes] = useState(0);

  // Scheduler
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig | null>(null);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [schedulerSaving, setSchedulerSaving] = useState(false);
  const schedulerPending = useRef(false);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);

  // Statistics (About)
  const [stats, setStats] = useState({
    totalDownloads: 0,
    totalUploaded: '0 GB',
    totalDownloaded: '0 GB',
    cacheSize: '0 MB',
    diskUsage: '0 GB',
    uptime: '0h 0m',
  });

  const dayNames = language === 'ru'
    ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
    : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  useEffect(() => {
    loadSettings();
    loadStats();
    const savedTheme = (localStorage.getItem('theme') as Theme) || 'system';
    setTheme(savedTheme);
    applyTheme(savedTheme);
    // Re-layer an active custom theme + the accent/font quick prefs so opening
    // Settings doesn't reset data-theme to the base (App.tsx already applied
    // them at boot; this keeps them when the lazy Settings tree mounts).
    const activeCustom = getActiveTheme();
    // Skip when the theme editor is open — it already owns :root with its live draft.
    if (!themeEditorOpen) { if (activeCustom) applyThemeObject(activeCustom); else restoreThemePrefs(); }

    window.api.getAutoLaunch().then(setAutoLaunch).catch(console.error);
    window.api.isDefaultClient().then(setIsDefaultClient).catch(console.error);
    window.api.getAppVersion().then(setAppVersion).catch(console.error);
    window.api.webRemote.getInfo().then(setWebRemote).catch(console.error);
    window.api.getRunningEngine().then(setRunningEngine).catch(console.error);
    window.api.getRunningTransport().then(setRunningTransport).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Live auto-update status from the main process
  useEffect(() => {
    const off = window.api.onUpdateStatus((status) => {
      switch (status.kind) {
        case 'checking':
          setMessage({ type: 'success', text: t('settings.msg.checking') });
          break;
        case 'available':
          setMessage({ type: 'success', text: t('settings.msg.updateAvailable') });
          break;
        case 'not-available':
          setMessage({ type: 'success', text: t('settings.msg.latest') });
          break;
        case 'downloading':
          setMessage({ type: 'success', text: `${t('settings.msg.downloading')} ${status.percent ?? 0}%` });
          break;
        case 'downloaded':
          setUpdateReady(String(status.version ?? ''));
          setMessage({ type: 'success', text: t('settings.msg.downloaded') });
          break;
        case 'error':
          setMessage({ type: 'error', text: `${t('settings.msg.updateError')} ${status.message ?? t('privacy.conf.unknown')}` });
          break;
        case 'dev-disabled':
          setMessage({ type: 'error', text: t('settings.msg.devOnly') });
          break;
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll UPnP port-forwarding status while the Connection tab is open
  // (was the Advanced tab before the IA regrouping).
  useEffect(() => {
    if (activeCategory !== 'connection') return;
    let alive = true;
    const tick = () => {
      window.api.getPortForwardStatus().then((s) => { if (alive) setPfStatus(s); }).catch(() => {});
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [activeCategory]);

  // Poll live network health while Connection is open AND adaptive throttle is on.
  useEffect(() => {
    if (activeCategory !== 'connection' || !adaptiveUpload) { setNetHealth(null); return; }
    let alive = true;
    const tick = () => {
      window.api.getNetworkHealth().then((h) => { if (alive) setNetHealth(h); }).catch(() => {});
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [activeCategory, adaptiveUpload]);

  // Live network/profile changes pushed from the monitor.
  useEffect(() => {
    const off = window.api.onNetworkProfile((p) => { setNetCurrent(p.current); setNetActiveId(p.activeId); });
    return off;
  }, []);

  // Track unsaved changes across the Save-bar fields (toggles auto-save).
  useEffect(() => {
    if (!settings) return;
    const s = settings as AppSettings;
    const changed =
      defaultDownloadDir !== s.defaultDownloadDir ||
      maxDownKbps !== s.maxDownKbps ||
      maxUpKbps !== s.maxUpKbps ||
      altDownKbps !== (s.altDownKbps ?? 0) ||
      altUpKbps !== (s.altUpKbps ?? 0) ||
      maxActiveDownloads !== s.maxActiveDownloads ||
      maxConnections !== (s.maxConnections ?? 55) ||
      maxConnectionsGlobal !== (s.maxConnectionsGlobal ?? 200) ||
      portMin !== (s.portMin ?? 6881) ||
      watchFolderPath !== (s.watchFolderPath ?? '') ||
      autoMovePath !== (s.autoMovePath ?? '') ||
      diskGuardMinFreeMB !== (s.diskGuardMinFreeMB ?? 2048) ||
      defaultSeedRatioLimit !== (s.defaultSeedRatioLimit ?? 0) ||
      defaultSeedTimeLimitMinutes !== (s.defaultSeedTimeLimitMinutes ?? 0) ||
      proxyHost !== (s.proxyHost ?? '') ||
      proxyPort !== (s.proxyPort ?? 8080) ||
      proxyType !== (s.proxyType ?? 'http') ||
      proxyUsername !== (s.proxyUsername ?? '') ||
      proxyPassword !== (s.proxyPassword ?? '') ||
      (schedulerConfig !== null && JSON.stringify(schedules) !== JSON.stringify(schedulerConfig.schedules));
    setHasChanges(changed);
  }, [
    settings, defaultDownloadDir, maxDownKbps, maxUpKbps, altDownKbps, altUpKbps, maxActiveDownloads,
    maxConnections, maxConnectionsGlobal, portMin,
    watchFolderPath, autoMovePath, diskGuardMinFreeMB,
    defaultSeedRatioLimit, defaultSeedTimeLimitMinutes,
    proxyHost, proxyPort, proxyType, proxyUsername, proxyPassword, schedulerConfig, schedules,
  ]);

  const applyTheme = (selectedTheme: Theme) => {
    if (selectedTheme === 'system') {
      const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', systemPrefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', selectedTheme);
    }
  };

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    applyTheme(newTheme); // data-theme baseline for the chosen dark/light/system
    // The dark/light selector now switches MODE, not theme: an active custom
    // theme stays active and re-applies its matching variant on top.
    const active = getActiveTheme();
    // Defer to the theme editor's live preview while it's open (don't clobber an unsaved draft).
    if (!themeEditorOpen) { if (active) applyThemeObject(active); else restoreThemePrefs(); }
  };

  const loadSettings = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const s = await window.api.getSettings();
      setSettings(s);
      setEngineState(s.engine === 'webtorrent' ? 'webtorrent' : 'native');
      setDefaultDownloadDir(s.defaultDownloadDir);
      setMaxDownKbps(s.maxDownKbps);
      setMaxUpKbps(s.maxUpKbps);
      setAdaptiveUpload(s.adaptiveUpload ?? false);
      setDohEnabled(s.dohEnabled ?? false);
      setDohTemplateId(s.dohTemplateId ?? 'cloudflare');
      window.api.getDohTemplates().then(setDohTemplates).catch(() => {});
      setNetEnabled(s.networkProfilesEnabled ?? false);
      window.api.getNetworkProfiles().then((r) => {
        setNetProfiles(r.profiles); setNetActiveId(r.activeId); setNetCurrent(r.current);
      }).catch(() => {});
      setMaxActiveDownloads(s.maxActiveDownloads);
      setAltSpeedEnabled(s.altSpeedEnabled ?? false);
      setAltDownKbps(s.altDownKbps ?? 0);
      setAltUpKbps(s.altUpKbps ?? 0);
      setAutoMoveEnabled(s.autoMoveEnabled ?? false);
      setAutoMovePath(s.autoMovePath ?? '');
      setMinimizeToTray(s.minimizeToTray ?? false);
      setCloseToTray(s.closeToTray ?? false);

      setEnableDHT(s.enableDHT ?? true);
      setEnableUtp(s.enableUtp ?? true);
      setEncryption(s.encryption === 'required' || s.encryption === 'tolerated' ? s.encryption : 'preferred');
      setMaxConnections(s.maxConnections ?? 55);
      setMaxConnectionsGlobal(s.maxConnectionsGlobal ?? 200);
      setPortMin(s.portMin ?? 6881);
      setPortForwarding(s.portForwarding ?? true);

      setProxyEnabled(s.proxyEnabled ?? false);
      setProxyType(s.proxyType === 'https' || s.proxyType === 'socks5' ? s.proxyType : 'http');
      setProxyHost(s.proxyHost ?? '');
      setProxyPort(s.proxyPort ?? 8080);
      setProxyUsername(s.proxyUsername ?? '');
      setProxyPassword(s.proxyPassword ?? '');

      setWatchFolderEnabled(s.watchFolderEnabled ?? false);
      setWatchFolderPath(s.watchFolderPath ?? '');
      setWatchFolderDeleteAfterAdd(s.watchFolderDeleteAfterAdd ?? false);

      setClipboardWatchEnabled(s.clipboardWatchEnabled ?? false);

      setDiskGuardEnabled(s.diskGuardEnabled ?? true);
      setDiskGuardMinFreeMB(s.diskGuardMinFreeMB ?? 2048);

      setShareUseTurn(s.shareUseTurn ?? true);
      setTurnUrl(s.customTurnUrl ?? '');
      setTurnUser(s.customTurnUsername ?? '');
      setTurnCred(s.customTurnCredential ?? '');
      setCustomTrackers(s.customTrackers ?? '');

      setDefaultSeedRatioLimit(s.defaultSeedRatioLimit ?? 0);
      setDefaultSeedTimeLimitMinutes(s.defaultSeedTimeLimitMinutes ?? 0);

      setEnableNotifications(s.enableNotifications ?? true);
      setEnableSounds(s.enableSounds ?? true);
      setNotifyOnComplete(s.notifyOnComplete ?? true);
      setNotifyOnError(s.notifyOnError ?? true);

      setAutoUpdate(s.autoUpdate ?? false);

      const scheduler = await window.api.getScheduler();
      setSchedulerConfig(scheduler);
      setSchedulerEnabled(scheduler.enabled);
      setSchedules(scheduler.schedules);
    } catch (error) {
      console.error('Failed to load settings:', error);
      setLoadFailed(true);
      setMessage({ type: 'error', text: t('settings.msg.loadFailed') });
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const realStats = await window.api.getAppStats();
      setStats({
        totalDownloads: realStats.totalDownloads,
        totalUploaded: realStats.totalUploaded,
        totalDownloaded: realStats.totalDownloaded,
        cacheSize: '-',
        diskUsage: realStats.diskUsage,
        uptime: `${realStats.activeDownloads} ${t('settings.stats.active')}, ${realStats.completedDownloads} ${t('settings.stats.done')}`,
      });
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const handleSchedulerToggle = async () => {
    if (schedulerPending.current) return;
    schedulerPending.current = true;
    setSchedulerSaving(true);
    const newEnabled = !schedulerEnabled;
    setSchedulerEnabled(newEnabled);
    const write = instantQueue.current.then(() => window.api.updateScheduler({ enabled: newEnabled }));
    instantQueue.current = write.then(() => {}, () => {});
    try {
      const updated = await write;
      setSchedulerConfig(updated);
      setMessage({ type: 'success', text: newEnabled ? t('settings.msg.schedOn') : t('settings.msg.schedOff') });
    } catch (error) {
      console.error('Failed to toggle scheduler:', error);
      setSchedulerEnabled(schedulerConfig?.enabled ?? !newEnabled);
      setMessage({ type: 'error', text: t('settings.msg.schedFailed') });
    } finally {
      schedulerPending.current = false;
      setSchedulerSaving(false);
    }
  };

  const handleAddSchedule = () => {
    const newSchedule: ScheduleEntry = {
      id: uuidv4(),
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '18:00',
    };
    setSchedules(prev => [...prev, newSchedule]);
  };

  const handleRemoveSchedule = (id: string) => {
    setSchedules(prev => prev.filter((s) => s.id !== id));
  };

  const handleUpdateSchedule = (id: string, updates: Partial<ScheduleEntry>) => {
    setSchedules(prev => prev.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  };

  const handleSelectDirectory = async () => {
    try {
      const path = await window.api.selectDirectory();
      if (path) {
        setDefaultDownloadDir(path);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  // Serialize writes so a slow earlier click cannot win over a later choice.
  // Read-back/rollback touches only that field, preserving unrelated drafts.
  const applyInstant = async <K extends keyof AppSettings,>(
    key: K, value: AppSettings[K], setter: (value: AppSettings[K]) => void,
    sideEffect?: () => unknown,
  ): Promise<boolean> => {
    const revision = (toggleRevision.current.get(key) ?? 0) + 1;
    toggleRevision.current.set(key, revision);
    const previous = settings?.[key];
    setter(value);
    setInstantSaving(count => count + 1);
    const write = instantQueue.current.then(async () => {
      // OS handlers persist only after successfully applying the setting.
      if (sideEffect) await sideEffect();
      await window.api.updateSettings({ [key]: value });
    });
    instantQueue.current = write.catch(() => {});
    try {
      await write;
      if (toggleRevision.current.get(key) === revision) {
        setSettings(prev => prev ? { ...prev, [key]: value } : prev);
      }
      return true;
    } catch (error) {
      console.error('Auto-save setting failed:', error);
      let restored = previous;
      try { restored = (await window.api.getSettings())[key]; } catch { /* Retain the last known value. */ }
      if (toggleRevision.current.get(key) === revision) {
        if (restored !== undefined) setter(restored);
        setSettings(prev => prev ? { ...prev, [key]: restored } : prev);
        setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
      }
      return false;
    } finally { setInstantSaving(count => Math.max(0, count - 1)); }
  };

  const applyToggle = async (
    value: boolean,
    setter: (v: boolean) => void,
    patch: Partial<AppSettings>,
    sideEffect?: (v: boolean) => unknown,
  ) => {
    const key = Object.keys(patch)[0] as keyof AppSettings;
    return applyInstant(key, value, restored => setter(!!restored), sideEffect ? () => sideEffect(value) : undefined);
  };

  // Download engine — persists instantly; applies on restart.
  const selectEngine = async (next: 'native' | 'webtorrent') => {
    if (next === engine) return;
    return applyInstant('engine', next, value => setEngineState(value === 'webtorrent' ? 'webtorrent' : 'native'));
  };
  const selectEncryption = (next: AppSettings['encryption']) => applyInstant('encryption', next, setEncryption);
  const engineRestartPending = runningEngine !== null && engine !== runningEngine;

  // Same "configured vs running" split as the engine picker, for the transport
  // toggles. Null runningTransport means the engine applies them live, so there
  // is nothing to warn about — and toggling back to the running value retracts
  // the notice instead of leaving it stuck.
  const transportRestartPending =
    runningTransport !== null &&
    (enableUtp !== runningTransport.utp || enableDHT !== runningTransport.dht);

  // Custom TURN relay — persisted on demand.
  const saveTurn = async () => {
    setTurnSaving(true);
    const patch = {
      customTurnUrl: turnUrl.trim(),
      customTurnUsername: turnUser.trim(),
      customTurnCredential: turnCred,
    };
    try {
      await window.api.updateSettings(patch);
      setSettings(prev => (prev ? { ...prev, ...patch } : prev));
      setMessage({ type: 'success', text: t('settings.customTurn.saved') });
    } catch {
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
    } finally { setTurnSaving(false); }
  };

  // Custom rendezvous trackers — persisted on demand, like the TURN block above.
  // The success message reports the accepted COUNT rather than just "saved":
  // invalid entries are dropped on the way in, so "saved" alone would let a typo
  // read as success while rooms quietly kept using the public defaults.
  const saveCustomTrackers = async () => {
    setTrackersSaving(true);
    const patch = { customTrackers: customTrackers.trim() };
    const accepted = parseTrackers(patch.customTrackers).length;
    try {
      await window.api.updateSettings(patch);
      setSettings(prev => (prev ? { ...prev, ...patch } : prev));
      setMessage(accepted
        ? { type: 'success', text: t('settings.customTrackers.saved').replace('{n}', String(accepted)) }
        : { type: 'success', text: t('settings.customTrackers.savedDefault') });
    } catch {
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
    } finally { setTrackersSaving(false); }
  };

  // ── DNS-over-HTTPS ────────────────────────────────────────────────────────
  const selectDohTemplate = async (id: string) => {
    return applyInstant('dohTemplateId', id, setDohTemplateId);
  };

  const addDohTemplate = async () => {
    if (!dohNewUrl.trim()) return;
    setDohAdding(true);
    try {
      const tpl = await window.api.addDohTemplate(dohNewName.trim() || dohNewUrl.trim(), dohNewUrl.trim());
      setDohTemplates(await window.api.getDohTemplates());
      setDohNewName(''); setDohNewUrl('');
      if (await selectDohTemplate(tpl.id)) setMessage({ type: 'success', text: t('settings.doh.added') });
    } catch (e) {
      setMessage({ type: 'error', text: String(e instanceof Error ? e.message : e) });
    } finally { setDohAdding(false); }
  };

  const deleteDohTemplate = async (id: string) => {
    try {
      await window.api.deleteDohTemplate(id);
      setDohTemplates(await window.api.getDohTemplates());
      const s = await window.api.getSettings();
      setDohTemplateId(s.dohTemplateId ?? 'cloudflare');
      setSettings(prev => prev ? { ...prev, dohTemplateId: s.dohTemplateId } : prev);
    } catch (e) { setMessage({ type: 'error', text: String(e instanceof Error ? e.message : e) }); }
  };

  const testDohTemplate = async (tpl: DohTemplate) => {
    setDohTest({ id: tpl.id, state: 'testing', text: t('settings.doh.testing') });
    try {
      const r = await window.api.testDohResolver(tpl.url);
      if (r.ok) setDohTest({ id: tpl.id, state: 'ok', text: `${r.ms} ms · ${r.ip}` });
      else setDohTest({ id: tpl.id, state: 'err', text: r.error || t('settings.doh.testFail') });
    } catch (e) { setDohTest({ id: tpl.id, state: 'err', text: String(e instanceof Error ? e.message : e) }); }
  };

  // ── Smart network profiles ────────────────────────────────────────────────
  const refreshNetProfiles = async () => {
    try { const r = await window.api.getNetworkProfiles(); setNetProfiles(r.profiles); setNetActiveId(r.activeId); setNetCurrent(r.current); }
    catch (e) { console.error(e); }
  };

  const saveCurrentAsProfile = async () => {
    if (!netCurrent?.key) { setMessage({ type: 'error', text: t('settings.net.noNetwork') }); return; }
    if (netProfiles.some((p) => p.networkKey === netCurrent.key)) { setMessage({ type: 'error', text: t('settings.net.alreadyHas') }); return; }
    const draft: NetworkProfile = { id: '', name: netCurrent.label || 'Network', networkKey: netCurrent.key, networkLabel: netCurrent.label, overrides: {} };
    setNetDraft(draft);
  };

  const saveNetDraft = async () => {
    if (!netDraft) return;
    try { await window.api.saveNetworkProfile(netDraft); setNetDraft(null); await refreshNetProfiles(); setMessage({ type: 'success', text: t('settings.net.saved') }); }
    catch (e) { setMessage({ type: 'error', text: String(e instanceof Error ? e.message : e) }); }
  };

  const removeNetProfile = async (id: string) => {
    try { await window.api.deleteNetworkProfile(id); if (netDraft?.id === id) setNetDraft(null); await refreshNetProfiles(); }
    catch (e) { setMessage({ type: 'error', text: String(e instanceof Error ? e.message : e) }); }
  };

  const toggleOverride = (key: keyof NetworkProfile['overrides'], on: boolean) => {
    setNetDraft((d) => {
      if (!d) return d;
      const overrides = { ...d.overrides };
      if (!on) { delete overrides[key]; }
      else {
        const seed = key === 'adaptiveUpload' || key === 'dohEnabled' ? true
          : key === 'maxConnectionsGlobal' ? 100
          : key === 'maxUpKbps' ? 200 : 0;
        (overrides as Record<string, number | boolean>)[key] = seed;
      }
      return { ...d, overrides };
    });
  };
  const setOverrideValue = (key: keyof NetworkProfile['overrides'], value: number | boolean) => {
    setNetDraft((d) => (d ? { ...d, overrides: { ...d.overrides, [key]: value } } : d));
  };

  // The watcher endpoint saves all three fields together. Keep that same
  // snapshot as the baseline; otherwise Cancel shows a different live folder.
  const applyWatchFolder = async (enabled: boolean, deleteAfter: boolean) => {
    if (enabled && !watchFolderPath.trim()) {
      setMessage({ type: 'error', text: t('settings.watchChooseFirst') });
      return;
    }
    const revision = ++watchRevision.current;
    const patch = { watchFolderPath, watchFolderEnabled: enabled, watchFolderDeleteAfterAdd: deleteAfter };
    setWatchFolderEnabled(enabled);
    setWatchFolderDeleteAfterAdd(deleteAfter);
    const write = instantQueue.current.then(() => window.api.setWatchFolder(patch.watchFolderPath, enabled, deleteAfter));
    instantQueue.current = write.catch(() => {});
    try {
      await write;
      setSettings(prev => prev ? { ...prev, ...patch } : prev);
    } catch {
      if (watchRevision.current !== revision) return;
      let saved = settings;
      try { saved = await window.api.getSettings(); } catch { /* Keep last known baseline. */ }
      setWatchFolderEnabled(saved?.watchFolderEnabled ?? false);
      setWatchFolderDeleteAfterAdd(saved?.watchFolderDeleteAfterAdd ?? false);
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
    }
  };

  const handleSave = async () => {
    if (!settings || savePending.current) return;
    savePending.current = true;
    setSaving(true);
    const fields = {
        defaultDownloadDir,
        maxDownKbps,
        maxUpKbps,
        altDownKbps,
        altUpKbps,
        maxActiveDownloads,
        maxConnections,
        maxConnectionsGlobal,
        portMin,
        watchFolderPath,
        autoMovePath,
        diskGuardMinFreeMB,
        defaultSeedRatioLimit,
        defaultSeedTimeLimitMinutes,
        proxyHost,
        proxyPort,
        proxyType,
        proxyUsername,
        proxyPassword,
    };
    const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== settings[key as keyof AppSettings])) as Partial<AppSettings>;
    const numericRules: Array<[keyof typeof fields, number, number, Parameters<typeof t>[0]]> = [
      ['maxDownKbps', 0, Number.MAX_SAFE_INTEGER, 'settings.downSpeed'],
      ['maxUpKbps', 0, Number.MAX_SAFE_INTEGER, 'settings.upSpeed'],
      ['altDownKbps', 0, Number.MAX_SAFE_INTEGER, 'settings.altDown'],
      ['altUpKbps', 0, Number.MAX_SAFE_INTEGER, 'settings.altUp'],
      ['maxActiveDownloads', 1, 10, 'settings.maxActive'],
      ['maxConnections', 10, 500, 'settings.maxConn'],
      ['maxConnectionsGlobal', 20, 2000, 'settings.maxConnGlobal'],
      ['portMin', 1024, 65535, 'settings.port'],
      ['diskGuardMinFreeMB', 100, Number.MAX_SAFE_INTEGER, 'settings.diskMin'],
      ['defaultSeedRatioLimit', 0, Number.MAX_SAFE_INTEGER, 'settings.seedRatio'],
      ['defaultSeedTimeLimitMinutes', 0, Number.MAX_SAFE_INTEGER, 'settings.seedTime'],
      ['proxyPort', 1, 65535, 'settings.proxyPort'],
    ];
    const invalidNumber = numericRules.find(([key, min, max]) => key in patch &&
      (!Number.isFinite(fields[key]) || Number(fields[key]) < min || Number(fields[key]) > max));
    const invalidLabel = invalidNumber?.[3]
      ?? ('defaultDownloadDir' in patch && !defaultDownloadDir.trim() ? 'settings.defaultDir' : null)
      ?? ('watchFolderPath' in patch && watchFolderEnabled && !watchFolderPath.trim() ? 'settings.watchPath' : null)
      ?? ('autoMovePath' in patch && autoMoveEnabled && !autoMovePath.trim() ? 'settings.autoMovePath' : null);
    if (invalidLabel) {
      setMessage({ type: 'error', text: t('settings.invalidValue').replace('{name}', t(invalidLabel)) });
      savePending.current = false;
      setSaving(false);
      return;
    }
    const scheduleSnapshot = schedulerConfig && JSON.stringify(schedules) !== JSON.stringify(schedulerConfig.schedules) ? structuredClone(schedules) : null;
    const write = instantQueue.current.then(async () => {
      if (patch.watchFolderPath !== undefined) {
        await window.api.setWatchFolder(watchFolderPath, watchFolderEnabled, watchFolderDeleteAfterAdd);
        setSettings(prev => prev ? { ...prev, watchFolderPath } : prev);
        delete patch.watchFolderPath;
      }
      if (Object.keys(patch).length) {
        await window.api.updateSettings(patch);
        // Advance only the submitted baseline. Later edits remain a draft.
        setSettings(prev => prev ? { ...prev, ...patch } : prev);
        if (Object.keys(patch).some(key => key.startsWith('proxy'))) setProxyRestartPending(true);
      }
      if (scheduleSnapshot) {
        const updated = await window.api.updateScheduler({ schedules: scheduleSnapshot });
        setSchedulerConfig(updated);
      }
    });
    instantQueue.current = write.catch(() => {});
    try {
      await write;
      setMessage({ type: 'success', text: t('settings.msg.saved') });
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: t('settings.msg.saveFailed') });
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (settings) {
      setDefaultDownloadDir(settings.defaultDownloadDir);
      setMaxDownKbps(settings.maxDownKbps);
      setMaxUpKbps(settings.maxUpKbps);
      setAltDownKbps(settings.altDownKbps ?? 0);
      setAltUpKbps(settings.altUpKbps ?? 0);
      setMaxActiveDownloads(settings.maxActiveDownloads);
      setMaxConnections(settings.maxConnections ?? 55);
      setMaxConnectionsGlobal(settings.maxConnectionsGlobal ?? 200);
      setPortMin(settings.portMin ?? 6881);
      setWatchFolderPath(settings.watchFolderPath ?? '');
      setAutoMovePath(settings.autoMovePath ?? '');
      setDiskGuardMinFreeMB(settings.diskGuardMinFreeMB ?? 2048);
      setDefaultSeedRatioLimit(settings.defaultSeedRatioLimit ?? 0);
      setDefaultSeedTimeLimitMinutes(settings.defaultSeedTimeLimitMinutes ?? 0);
      setProxyHost(settings.proxyHost ?? '');
      setProxyPort(settings.proxyPort ?? 8080);
      setProxyType(settings.proxyType === 'https' || settings.proxyType === 'socks5' ? settings.proxyType : 'http');
      setProxyUsername(settings.proxyUsername ?? '');
      setProxyPassword(settings.proxyPassword ?? '');
      setHasChanges(false);
    }
    if (schedulerConfig) {
      setSchedulerEnabled(schedulerConfig.enabled);
      setSchedules([...schedulerConfig.schedules]);
    }
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    try {
      await window.api.clearCache();
      setMessage({ type: 'success', text: t('settings.msg.cacheCleared') });
    } catch (error) {
      console.error('Failed to clear cache:', error);
      setMessage({ type: 'error', text: t('settings.msg.cacheFailed') });
    } finally {
      setClearingCache(false);
    }
  };

  const handleSetDefaultClient = async () => {
    try {
      const result = await window.api.setDefaultClient();
      if (result.success) {
        setIsDefaultClient(true);
        setMessage({ type: 'success', text: t('settings.msg.defaultSet') });
      } else {
        setMessage({ type: 'error', text: t('settings.msg.defaultFailed') });
      }
    } catch (error) {
      console.error('Failed to set default client:', error);
      setMessage({ type: 'error', text: t('settings.msg.defaultFailed') });
    }
  };

  const handleExportSettings = async () => {
    if (themeEditorOpen || hasChanges) { setMessage({ type: 'error', text: t('settings.transfer.finishEditing') }); return; }
    setTransferBusy(true);
    try {
      const result = await window.api.exportSettings({ sections: selectedTransferSections });
      if (result.success) {
        setMessage({ type: 'success', text: t('settings.msg.exported') });
      }
    } catch (error) {
      console.error('Failed to export settings:', error);
      setMessage({ type: 'error', text: t('settings.msg.exportFailed') });
    } finally { setTransferBusy(false); }
  };

  const handleImportSettings = async () => {
    if (themeEditorOpen || hasChanges) { setMessage({ type: 'error', text: t('settings.transfer.finishEditing') }); return; }
    setTransferBusy(true);
    try {
      const result = await window.api.importSettings({ sections: selectedTransferSections });
      if (result.success) {
        await loadSettings();
        setMessage({ type: 'success', text: t('settings.msg.imported') });
      }
    } catch (error) {
      console.error('Failed to import settings:', error);
      setMessage({ type: 'error', text: t('settings.msg.importFailed') });
    } finally { await refreshTransferStatus().catch(() => {}); setTransferBusy(false); }
  };

  const handleRestoreSettings = async () => {
    if (themeEditorOpen || hasChanges) { setMessage({ type: 'error', text: t('settings.transfer.finishEditing') }); return; }
    setTransferBusy(true);
    try {
      const result = await window.api.restoreSettings({ sections: selectedTransferSections });
      if (result.success) { await loadSettings(); setMessage({ type: 'success', text: t('settings.transfer.restored') }); }
    } catch { setMessage({ type: 'error', text: t('settings.transfer.restoreFailed') }); }
    finally { await refreshTransferStatus().catch(() => {}); setTransferBusy(false); }
  };
  const handleRecoverSettings = async () => {
    if (themeEditorOpen || hasChanges) { setMessage({ type: 'error', text: t('settings.transfer.finishEditing') }); return; }
    setTransferBusy(true);
    try {
      await window.api.recoverSettingsTransfer(); await loadSettings();
      setMessage({ type: 'success', text: t('settings.transfer.restored') });
    } catch { setMessage({ type: 'error', text: t('settings.transfer.restoreFailed') }); }
    finally { await refreshTransferStatus().catch(() => {}); setTransferBusy(false); }
  };

  useEffect(() => {
    const refresh = () => {
      const mode = localStorage.getItem('theme'); setTheme(mode === 'light' || mode === 'dark' ? mode : 'system');
      if (!hasChanges && !themeEditorOpen) void loadSettings();
    };
    window.addEventListener(WORKING_PROFILE_EVENT, refresh);
    return () => window.removeEventListener(WORKING_PROFILE_EVENT, refresh);
    // loadSettings is a controller function; the guard must read current draft flags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges, themeEditorOpen]);

  const handleCheckForUpdates = async () => {
    setMessage({ type: 'success', text: t('settings.msg.checking') });
    try {
      const res = await window.api.checkForUpdates();
      if (!res.ok && res.reason === 'dev') {
        setMessage({ type: 'error', text: t('settings.msg.devOnly2') });
      }
    } catch {
      setMessage({ type: 'error', text: t('settings.msg.checkFailed') });
    }
  };

  return {
    // navigation
    activeCategory, setActiveCategory,
    // load/save machinery
    settings, setSettings, loading, loadFailed, saving, instantSaving, clearingCache, message, setMessage,
    hasChanges, loadSettings, loadStats, handleSave, handleReset,
    applyToggle,
    // app/version/update
    appVersion, updateReady, handleCheckForUpdates,
    // general
    defaultDownloadDir, setDefaultDownloadDir, handleSelectDirectory,
    theme, handleThemeChange,
    engine, runningEngine, selectEngine, engineRestartPending,
    engineCapabilities, engineCapabilitiesFailed,
    // notifications
    enableNotifications, setEnableNotifications,
    enableSounds, setEnableSounds,
    notifyOnComplete, setNotifyOnComplete,
    notifyOnError, setNotifyOnError,
    // system
    autoLaunch, setAutoLaunch, autoUpdate, setAutoUpdate,
    minimizeToTray, setMinimizeToTray, closeToTray, setCloseToTray,
    isDefaultClient, handleSetDefaultClient,
    handleClearCache, handleExportSettings, handleImportSettings,
    selectedTransferSections, setSelectedTransferSections, transferBusy, transferStatus, handleRestoreSettings, handleRecoverSettings, exportObservation,
    // connection
    maxDownKbps, setMaxDownKbps, maxUpKbps, setMaxUpKbps,
    adaptiveUpload, setAdaptiveUpload, netHealth,
    maxActiveDownloads, setMaxActiveDownloads,
    altSpeedEnabled, setAltSpeedEnabled, altDownKbps, setAltDownKbps, altUpKbps, setAltUpKbps,
    enableDHT, setEnableDHT, enableUtp, setEnableUtp, transportRestartPending,
    encryption, setEncryption, selectEncryption,
    maxConnections, setMaxConnections, maxConnectionsGlobal, setMaxConnectionsGlobal,
    portMin, setPortMin, portForwarding, setPortForwarding, pfStatus,
    proxyEnabled, setProxyEnabled, proxyType, setProxyType,
    proxyHost, setProxyHost, proxyPort, setProxyPort,
    proxyUsername, setProxyUsername, proxyPassword, setProxyPassword,
    proxyRestartPending, setProxyRestartPending,
    // DoH
    dohEnabled, setDohEnabled, dohTemplateId, dohTemplates,
    dohNewName, setDohNewName, dohNewUrl, setDohNewUrl, dohAdding, dohTest,
    selectDohTemplate, addDohTemplate, deleteDohTemplate, testDohTemplate,
    // network profiles
    netEnabled, setNetEnabled, netProfiles, netCurrent, netActiveId,
    netDraft, setNetDraft, refreshNetProfiles, saveCurrentAsProfile, saveNetDraft,
    removeNetProfile, toggleOverride, setOverrideValue,
    // downloads
    watchFolderEnabled, setWatchFolderEnabled, watchFolderPath, setWatchFolderPath,
    watchFolderDeleteAfterAdd, setWatchFolderDeleteAfterAdd, applyWatchFolder,
    clipboardWatchEnabled, setClipboardWatchEnabled,
    autoMoveEnabled, setAutoMoveEnabled, autoMovePath, setAutoMovePath,
    diskGuardEnabled, setDiskGuardEnabled, diskGuardMinFreeMB, setDiskGuardMinFreeMB,
    // sharing
    shareUseTurn, setShareUseTurn,
    turnUrl, setTurnUrl, turnUser, setTurnUser, turnCred, setTurnCred, turnSaving, saveTurn,
    customTrackers, setCustomTrackers, trackersSaving, saveCustomTrackers,
    webRemote, setWebRemote, remoteCopied, setRemoteCopied,
    // seeding
    defaultSeedRatioLimit, setDefaultSeedRatioLimit,
    defaultSeedTimeLimitMinutes, setDefaultSeedTimeLimitMinutes,
    // scheduler
    schedulerConfig, schedulerEnabled, schedulerSaving, schedules, setSchedules, dayNames,
    handleSchedulerToggle, handleAddSchedule, handleRemoveSchedule, handleUpdateSchedule,
    // stats (About)
    stats,
  };
}

export type SettingsController = ReturnType<typeof useSettingsController>;

const SettingsCtx = createContext<SettingsController | null>(null);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const controller = useSettingsController();
  return <SettingsCtx.Provider value={controller}>{children}</SettingsCtx.Provider>;
};

export const useSettings = (): SettingsController => {
  const ctx = useContext(SettingsCtx);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
};
