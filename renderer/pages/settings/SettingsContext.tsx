/**
 * Settings controller — ALL settings state, loading, and save logic in one
 * provider. Extracted verbatim from the old 1900-line SettingsPage monolith so
 * behavior is unchanged; section components consume it via useSettings().
 *
 * Save model (unchanged):
 *  - Toggles auto-save instantly through applyToggle (optimistic baseline).
 *  - Engine / DoH resolver / TURN persist instantly through their own handlers.
 *  - Text/number/select fields flip hasChanges and go through the Save bar.
 */
import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  AppSettings, SchedulerConfig, ScheduleEntry, PortForwardStatus, NetworkHealth,
  DohTemplate, NetworkProfile, NetworkInfo,
} from '../../../shared/types';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../../utils/i18nContext';
import { getActiveTheme, applyThemeObject } from '../../utils/theme-library';
import { restoreThemePrefs } from '../../utils/theme-prefs';

export type Theme = 'light' | 'dark' | 'system';

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
function useSettingsController() {
  const { t, language } = useTranslation();

  const [activeCategory, setActiveCategory] = useState('general');

  // App version + update state
  const [appVersion, setAppVersion] = useState('');
  const [updateReady, setUpdateReady] = useState<string | null>(null);

  // Settings load/save state
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // General
  const [defaultDownloadDir, setDefaultDownloadDir] = useState('');
  const [theme, setTheme] = useState<Theme>('system');
  const [engine, setEngineState] = useState<'native' | 'webtorrent'>('native');
  const [runningEngine, setRunningEngine] = useState<'native' | 'webtorrent' | null>(null);

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
  const [maxConnections, setMaxConnections] = useState(55);
  const [maxConnectionsGlobal, setMaxConnectionsGlobal] = useState(200);
  const [portMin, setPortMin] = useState(6881);
  const [portForwarding, setPortForwarding] = useState(true);
  const [pfStatus, setPfStatus] = useState<PortForwardStatus | null>(null);

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

  // Seeding limits
  const [defaultSeedRatioLimit, setDefaultSeedRatioLimit] = useState(0);
  const [defaultSeedTimeLimitMinutes, setDefaultSeedTimeLimitMinutes] = useState(0);

  // Scheduler
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig | null>(null);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
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
    if (activeCustom) applyThemeObject(activeCustom); else restoreThemePrefs();

    window.api.getAutoLaunch().then(setAutoLaunch).catch(console.error);
    window.api.isDefaultClient().then(setIsDefaultClient).catch(console.error);
    window.api.getAppVersion().then(setAppVersion).catch(console.error);
    window.api.webRemote.getInfo().then(setWebRemote).catch(console.error);
    window.api.getRunningEngine().then(setRunningEngine).catch(console.error);
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
      maxConnections !== s.maxConnections ||
      maxConnectionsGlobal !== (s.maxConnectionsGlobal ?? 200) ||
      portMin !== s.portMin ||
      watchFolderPath !== s.watchFolderPath ||
      autoMovePath !== (s.autoMovePath ?? '') ||
      diskGuardMinFreeMB !== (s.diskGuardMinFreeMB ?? 2048) ||
      defaultSeedRatioLimit !== s.defaultSeedRatioLimit ||
      defaultSeedTimeLimitMinutes !== s.defaultSeedTimeLimitMinutes;
    setHasChanges(changed);
  }, [
    settings, defaultDownloadDir, maxDownKbps, maxUpKbps, altDownKbps, altUpKbps, maxActiveDownloads,
    maxConnections, maxConnectionsGlobal, portMin,
    watchFolderPath, autoMovePath, diskGuardMinFreeMB,
    defaultSeedRatioLimit, defaultSeedTimeLimitMinutes,
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
    if (active) applyThemeObject(active); else restoreThemePrefs();
  };

  const loadSettings = async () => {
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
      setMaxConnections(s.maxConnections ?? 55);
      setMaxConnectionsGlobal(s.maxConnectionsGlobal ?? 200);
      setPortMin(s.portMin ?? 6881);
      setPortForwarding(s.portForwarding ?? true);

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
    try {
      const newEnabled = !schedulerEnabled;
      await window.api.updateScheduler({ enabled: newEnabled });
      setSchedulerEnabled(newEnabled);
      setMessage({ type: 'success', text: newEnabled ? t('settings.msg.schedOn') : t('settings.msg.schedOff') });
    } catch (error) {
      console.error('Failed to toggle scheduler:', error);
      setMessage({ type: 'error', text: t('settings.msg.schedFailed') });
    }
  };

  const handleAddSchedule = () => {
    const newSchedule: ScheduleEntry = {
      id: uuidv4(),
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '18:00',
    };
    setSchedules([...schedules, newSchedule]);
  };

  const handleRemoveSchedule = (id: string) => {
    setSchedules(schedules.filter((s) => s.id !== id));
  };

  const handleUpdateSchedule = (id: string, updates: Partial<ScheduleEntry>) => {
    setSchedules(schedules.map((s) => (s.id === id ? { ...s, ...updates } : s)));
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

  // Auto-save a single toggle the moment it's clicked (optimistic baseline).
  const applyToggle = async (
    value: boolean,
    setter: (v: boolean) => void,
    patch: Partial<AppSettings>,
    sideEffect?: (v: boolean) => unknown,
  ) => {
    setter(value);
    setSettings(prev => (prev ? { ...prev, ...patch } : prev));
    try {
      await window.api.updateSettings(patch);
      if (sideEffect) await sideEffect(value);
    } catch (err) {
      console.error('Auto-save toggle failed:', err);
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
      await loadSettings();
    }
  };

  // Download engine — persists instantly; applies on restart.
  const selectEngine = async (next: 'native' | 'webtorrent') => {
    if (next === engine) return;
    setEngineState(next);
    setSettings(prev => (prev ? { ...prev, engine: next } : prev));
    try {
      await window.api.updateSettings({ engine: next });
    } catch (err) {
      console.error('Failed to set engine:', err);
      setMessage({ type: 'error', text: t('settings.msg.autosaveFailed') });
      await loadSettings();
    }
  };
  const engineRestartPending = runningEngine !== null && engine !== runningEngine;

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

  // ── DNS-over-HTTPS ────────────────────────────────────────────────────────
  const selectDohTemplate = async (id: string) => {
    setDohTemplateId(id);
    setSettings((prev) => (prev ? { ...prev, dohTemplateId: id } : prev));
    try { await window.api.updateSettings({ dohTemplateId: id }); }
    catch (err) { console.error('Failed to set DoH resolver:', err); await loadSettings(); }
  };

  const addDohTemplate = async () => {
    if (!dohNewUrl.trim()) return;
    setDohAdding(true);
    try {
      const tpl = await window.api.addDohTemplate(dohNewName.trim() || dohNewUrl.trim(), dohNewUrl.trim());
      setDohTemplates(await window.api.getDohTemplates());
      setDohNewName(''); setDohNewUrl('');
      await selectDohTemplate(tpl.id);
      setMessage({ type: 'success', text: t('settings.doh.added') });
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
      setSettings(s);
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

  // Watch-folder toggles push the live path + both flags to the watcher.
  const applyWatchFolder = (enabled: boolean, deleteAfter: boolean) => {
    if (window.api.setWatchFolder) {
      return window.api.setWatchFolder(watchFolderPath, enabled, deleteAfter);
    }
  };

  const handleSave = async () => {
    if (!settings) return;

    setSaving(true);
    try {
      await window.api.updateSettings({
        defaultDownloadDir,
        maxDownKbps,
        maxUpKbps,
        altSpeedEnabled,
        altDownKbps,
        altUpKbps,
        maxActiveDownloads,
        minimizeToTray,
        closeToTray,
        enableDHT,
        maxConnections,
        maxConnectionsGlobal,
        portMin,
        watchFolderEnabled,
        watchFolderPath,
        watchFolderDeleteAfterAdd,
        autoMoveEnabled,
        autoMovePath,
        diskGuardEnabled,
        diskGuardMinFreeMB,
        defaultSeedRatioLimit,
        defaultSeedTimeLimitMinutes,
        enableNotifications,
        enableSounds,
        notifyOnComplete,
        notifyOnError,
        autoLaunch,
        autoUpdate,
      });

      try {
        if (window.api.setWatchFolder) {
          await window.api.setWatchFolder(watchFolderPath, watchFolderEnabled, watchFolderDeleteAfterAdd);
        }
      } catch (e) { /* non-critical */ }

      if (autoLaunch !== await window.api.getAutoLaunch()) {
        await window.api.setAutoLaunch(autoLaunch);
      }

      await window.api.setMinimizeToTray(minimizeToTray);
      await window.api.setCloseToTray(closeToTray);

      if (schedulerConfig) {
        await window.api.updateScheduler({
          enabled: schedulerEnabled,
          schedules,
        });
      }

      setMessage({ type: 'success', text: t('settings.msg.saved') });
      setHasChanges(false);
      await loadSettings();
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: t('settings.msg.saveFailed') });
    } finally {
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
    try {
      const result = await window.api.exportSettings();
      if (result.success) {
        setMessage({ type: 'success', text: t('settings.msg.exported') });
      }
    } catch (error) {
      console.error('Failed to export settings:', error);
      setMessage({ type: 'error', text: t('settings.msg.exportFailed') });
    }
  };

  const handleImportSettings = async () => {
    try {
      const result = await window.api.importSettings();
      if (result.success) {
        await loadSettings();
        setMessage({ type: 'success', text: t('settings.msg.imported') });
      }
    } catch (error) {
      console.error('Failed to import settings:', error);
      setMessage({ type: 'error', text: t('settings.msg.importFailed') });
    }
  };

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
    settings, setSettings, loading, saving, clearingCache, message, setMessage,
    hasChanges, loadSettings, loadStats, handleSave, handleReset,
    applyToggle,
    // app/version/update
    appVersion, updateReady, handleCheckForUpdates,
    // general
    defaultDownloadDir, setDefaultDownloadDir, handleSelectDirectory,
    theme, handleThemeChange,
    engine, runningEngine, selectEngine, engineRestartPending,
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
    // connection
    maxDownKbps, setMaxDownKbps, maxUpKbps, setMaxUpKbps,
    adaptiveUpload, setAdaptiveUpload, netHealth,
    maxActiveDownloads, setMaxActiveDownloads,
    altSpeedEnabled, setAltSpeedEnabled, altDownKbps, setAltDownKbps, altUpKbps, setAltUpKbps,
    enableDHT, setEnableDHT, enableUtp, setEnableUtp,
    maxConnections, setMaxConnections, maxConnectionsGlobal, setMaxConnectionsGlobal,
    portMin, setPortMin, portForwarding, setPortForwarding, pfStatus,
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
    webRemote, setWebRemote, remoteCopied, setRemoteCopied,
    // seeding
    defaultSeedRatioLimit, setDefaultSeedRatioLimit,
    defaultSeedTimeLimitMinutes, setDefaultSeedTimeLimitMinutes,
    // scheduler
    schedulerConfig, schedulerEnabled, schedules, dayNames,
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
