/**
 * Settings Page - Professional Desktop Design 2026
 * 
 * Complete redesign with sidebar navigation and semantic grouping.
 */

import React, { useState, useEffect } from 'react';
import { AppSettings, SchedulerConfig, ScheduleEntry, PortForwardStatus, NetworkHealth, DohTemplate, NetworkProfile, NetworkInfo } from '../../shared/types';
import {
  Button,
  Icon,
  Select,
  Alert,
  ThemeSelector,
  SettingsSidebar,
  SettingsCategory,
  QRCode,
} from '../components';
import { PrivacySettings } from '../components/PrivacySettings';
import { AboutSection } from './settings/AboutSection';
import './SettingsPage.css';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../utils/i18nContext';

type Theme = 'light' | 'dark' | 'system';

const SettingsPage: React.FC = () => {
  const { t, language, setLanguage } = useTranslation();

  // Active category
  const [activeCategory, setActiveCategory] = useState('general');

  // App version (single source of truth: package.json via Electron)
  const [appVersion, setAppVersion] = useState('');
  // Set when an update has been downloaded and is ready to install
  const [updateReady, setUpdateReady] = useState<string | null>(null);

  // Settings state
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // General settings
  const [defaultDownloadDir, setDefaultDownloadDir] = useState('');
  const [theme, setTheme] = useState<Theme>('system');

  // Notification settings
  const [enableNotifications, setEnableNotifications] = useState(true);
  const [enableSounds, setEnableSounds] = useState(true);
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [notifyOnError, setNotifyOnError] = useState(true);

  // System settings
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [isDefaultClient, setIsDefaultClient] = useState(false);

  // Network settings
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

  // Advanced settings (proxy UI removed — WebTorrent has no proxy support;
  // PEX/LSD toggles removed — not switchable/implemented in WebTorrent)
  const [enableDHT, setEnableDHT] = useState(true);
  const [enableUtp, setEnableUtp] = useState(false);
  const [maxConnections, setMaxConnections] = useState(55);
  const [maxConnectionsGlobal, setMaxConnectionsGlobal] = useState(200);
  const [portMin, setPortMin] = useState(6881);
  const [portForwarding, setPortForwarding] = useState(true);
  const [pfStatus, setPfStatus] = useState<PortForwardStatus | null>(null);

  // Watch folder settings
  const [watchFolderEnabled, setWatchFolderEnabled] = useState(false);
  const [watchFolderPath, setWatchFolderPath] = useState('');
  const [watchFolderDeleteAfterAdd, setWatchFolderDeleteAfterAdd] = useState(false);

  // Disk-space guard
  const [diskGuardEnabled, setDiskGuardEnabled] = useState(true);
  const [diskGuardMinFreeMB, setDiskGuardMinFreeMB] = useState(2048);

  // Sharing
  const [shareUseTurn, setShareUseTurn] = useState(true);
  const [turnUrl, setTurnUrl] = useState('');
  const [turnUser, setTurnUser] = useState('');
  const [turnCred, setTurnCred] = useState('');
  const [turnSaving, setTurnSaving] = useState(false);

  // Default seeding limits
  const [defaultSeedRatioLimit, setDefaultSeedRatioLimit] = useState(0);
  const [defaultSeedTimeLimitMinutes, setDefaultSeedTimeLimitMinutes] = useState(0);

  // Scheduler state
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig | null>(null);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);

  // Statistics
  const [stats, setStats] = useState({
    totalDownloads: 0,
    totalUploaded: '0 GB',
    totalDownloaded: '0 GB',
    cacheSize: '0 MB',
    diskUsage: '0 GB',
    uptime: '0h 0m',
  });

  // Categories definition with semantic grouping
  const categories: SettingsCategory[] = [
    // Core Settings
    { id: 'general', label: t('settings.general'), icon: 'settings', group: 'core' },
    { id: 'downloads', label: t('settings.downloads'), icon: 'download', group: 'core' },
    { id: 'network', label: t('settings.network'), icon: 'activity', group: 'core' },
    
    // Advanced
    { id: 'advanced', label: t('settings.advanced'), icon: 'layers', group: 'advanced' },
    { id: 'scheduler', label: t('settings.scheduler'), icon: 'calendar', group: 'advanced' },
    { id: 'seeding', label: t('settings.seeding'), icon: 'share-2', group: 'advanced' },

    // Privacy & Security
    { id: 'privacy', label: t('settings.privacy'), icon: 'shield', group: 'security' },

    // Appearance
    { id: 'interface', label: t('settings.interface'), icon: 'sun', group: 'appearance' },
    { id: 'notifications', label: t('settings.notifications'), icon: 'bell', group: 'appearance' },
    
    // System
    { id: 'system', label: t('settings.system'), icon: 'power', group: 'system' },

    // Other
    { id: 'about', label: t('settings.about'), icon: 'info', group: 'other' },
  ];

  const dayNames = language === 'ru'
    ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
    : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  useEffect(() => {
    loadSettings();
    loadStats();
    const savedTheme = localStorage.getItem('theme') as Theme || 'system';
    setTheme(savedTheme);
    applyTheme(savedTheme);

    // Load system settings not in standard settings object
    window.api.getAutoLaunch().then(setAutoLaunch).catch(console.error);
    window.api.isDefaultClient().then(setIsDefaultClient).catch(console.error);
    window.api.getAppVersion().then(setAppVersion).catch(console.error);
    window.api.webRemote.getInfo().then(setWebRemote).catch(console.error);
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
          setMessage({ type: 'error', text: `${t('settings.msg.updateError')} ${status.message ?? 'unknown'}` });
          break;
        case 'dev-disabled':
          setMessage({ type: 'error', text: t('settings.msg.devOnly') });
          break;
      }
    });
    return () => off();
  }, []);

  // Poll UPnP port-forwarding status while the Advanced tab is open.
  useEffect(() => {
    if (activeCategory !== 'advanced') return;
    let alive = true;
    const tick = () => {
      window.api.getPortForwardStatus().then((s) => { if (alive) setPfStatus(s); }).catch(() => {});
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [activeCategory]);

  // Poll live network health while the Network tab is open AND adaptive throttle
  // is on — drives the live latency/cap indicator. Matches the throttle's 2s loop.
  useEffect(() => {
    if (activeCategory !== 'network' || !adaptiveUpload) { setNetHealth(null); return; }
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

  // Track unsaved changes across ALL persisted fields (not just a handful),
  // so the Save bar appears whenever anything actually changed.
  useEffect(() => {
    if (!settings) return;
    const s = settings as AppSettings;
    // Only text/number/select inputs drive the Save bar — toggles auto-save on click.
    const changed =
      defaultDownloadDir !== s.defaultDownloadDir ||
      maxDownKbps !== s.maxDownKbps ||
      maxUpKbps !== s.maxUpKbps ||
      altDownKbps !== (s.altDownKbps ?? 0) ||
      altUpKbps !== (s.altUpKbps ?? 0) ||
      maxActiveDownloads !== s.maxActiveDownloads ||
      // Advanced
      maxConnections !== s.maxConnections ||
      maxConnectionsGlobal !== (s.maxConnectionsGlobal ?? 200) ||
      portMin !== s.portMin ||
      // Watch folder
      watchFolderPath !== s.watchFolderPath ||
      // Auto-move
      autoMovePath !== (s.autoMovePath ?? '') ||
      // Disk guard
      diskGuardMinFreeMB !== (s.diskGuardMinFreeMB ?? 2048) ||
      // Seeding
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
    applyTheme(newTheme);
  };

  const loadSettings = async () => {
    try {
      const s = await window.api.getSettings();
      setSettings(s);
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

      // Advanced settings
      setEnableDHT(s.enableDHT ?? true);
      setEnableUtp(s.enableUtp ?? false);
      setMaxConnections(s.maxConnections ?? 55);
      setMaxConnectionsGlobal(s.maxConnectionsGlobal ?? 200);
      setPortMin(s.portMin ?? 6881);
      setPortForwarding(s.portForwarding ?? true);

      // Watch folder
      setWatchFolderEnabled(s.watchFolderEnabled ?? false);
      setWatchFolderPath(s.watchFolderPath ?? '');
      setWatchFolderDeleteAfterAdd(s.watchFolderDeleteAfterAdd ?? false);

      // Disk-space guard
      setDiskGuardEnabled(s.diskGuardEnabled ?? true);
      setDiskGuardMinFreeMB(s.diskGuardMinFreeMB ?? 2048);

      // Sharing
      setShareUseTurn(s.shareUseTurn ?? true);
      setTurnUrl(s.customTurnUrl ?? '');
      setTurnUser(s.customTurnUsername ?? '');
      setTurnCred(s.customTurnCredential ?? '');

      // Default seeding limits
      setDefaultSeedRatioLimit(s.defaultSeedRatioLimit ?? 0);
      setDefaultSeedTimeLimitMinutes(s.defaultSeedTimeLimitMinutes ?? 0);

      // Notifications
      setEnableNotifications(s.enableNotifications ?? true);
      setEnableSounds(s.enableSounds ?? true);
      setNotifyOnComplete(s.notifyOnComplete ?? true);
      setNotifyOnError(s.notifyOnError ?? true);

      // Auto-update preference (persisted in settings)
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
        uptime: `${realStats.activeDownloads} active, ${realStats.completedDownloads} done`,
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

  // Auto-save a single toggle the moment it's clicked. Text/number fields still
  // go through the Save bar, but switches persist instantly (and run any
  // side-effect, e.g. registering auto-launch with the OS). The settings
  // baseline is updated optimistically so the Save bar doesn't appear for them.
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

  // Custom TURN relay — persisted on demand (used at the next connection, not live).
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

  // ── DNS-over-HTTPS ─────────────────────────────────────────────────────────
  // Selecting a resolver persists + applies live (like a toggle), so it doesn't
  // go through the Save bar.
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
      await selectDohTemplate(tpl.id); // make the new one active
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

  // ── Smart network profiles ───────────────────────────────────────────────
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

  // Toggle a single override on/off in the draft (on = seed with a sensible value).
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

  // Watch-folder toggles need the live path + both flags pushed to the watcher.
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
        // Advanced
        enableDHT,
        maxConnections,
        maxConnectionsGlobal,
        portMin,
        // Watch folder
        watchFolderEnabled,
        watchFolderPath,
        watchFolderDeleteAfterAdd,
        // Auto-move
        autoMoveEnabled,
        autoMovePath,
        // Disk guard
        diskGuardEnabled,
        diskGuardMinFreeMB,
        // Seeding limits
        defaultSeedRatioLimit,
        defaultSeedTimeLimitMinutes,
        // Notifications
        enableNotifications,
        enableSounds,
        notifyOnComplete,
        notifyOnError,
        // System
        autoLaunch,
        autoUpdate,
      });

      // Apply watch folder change immediately
      try {
        if (window.api.setWatchFolder) {
          await window.api.setWatchFolder(watchFolderPath, watchFolderEnabled, watchFolderDeleteAfterAdd);
        }
      } catch (e) { /* non-critical */ }

      if (autoLaunch !== await window.api.getAutoLaunch()) {
        await window.api.setAutoLaunch(autoLaunch);
      }

      // Apply tray behavior immediately (main process reads these live)
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
      // Revert every input field the Save bar tracks back to the saved values.
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
      // Other outcomes (available / not-available / downloading / downloaded /
      // error) arrive via the onUpdateStatus subscription below.
    } catch {
      setMessage({ type: 'error', text: t('settings.msg.checkFailed') });
    }
  };

  if (loading) {
    return (
      <div className="settings-page settings-loading">
        <Icon name="loader" size={32} />
        <p>{t('settings.loading')}</p>
      </div>
    );
  }

  // Render setting group helper
  const renderSettingItem = (
    label: string,
    description: string,
    control: React.ReactNode,
    icon?: React.ReactNode
  ) => (
    <div className="setting-item">
      <div className="setting-info">
        <div className="setting-label">
          {icon}
          {label}
        </div>
        <p className="setting-description">{description}</p>
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );

  const renderToggle = (active: boolean, onChange: () => void) => (
    <button className={`toggle-switch ${active ? 'active' : ''}`} onClick={onChange}>
      <span className="toggle-slider" />
    </button>
  );

  return (
    <div className="settings-page">
      {message && (
        <div className="settings-alert">
          <Alert variant={message.type === 'success' ? 'success' : 'error'} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        </div>
      )}

      <SettingsSidebar
        categories={categories}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
      />

      <div className="settings-content">
        <div className="settings-content-inner">{renderCategoryContent()}</div>

        {hasChanges && (
          <div className="settings-actions">
            <Button variant="secondary" onClick={handleReset}>
              {t('settings.cancel')}
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={saving}>
              {t('settings.saveChanges')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  function renderCategoryContent() {
    switch (activeCategory) {
      case 'general':
        return renderGeneralSettings();
      case 'downloads':
        return renderDownloadSettings();
      case 'network':
        return renderNetworkSettings();
      case 'advanced':
        return renderAdvancedSettings();
      case 'privacy':
        return renderPrivacySettings();
      case 'scheduler':
        return renderSchedulerSettings();
      case 'seeding':
        return renderSeedingSettings();
      case 'interface':
        return renderInterfaceSettings();
      case 'notifications':
        return renderNotificationSettings();
      case 'system':
        return renderSystemSettings();
      case 'about':
        return renderAboutSettings();
      default:
        return null;
    }
  }

  function renderGeneralSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.general')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.general')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.application')}</h3>
          {renderSettingItem(
            t('settings.autoLaunch'),
            t('settings.autoLaunch.desc'),
            renderToggle(autoLaunch, () => applyToggle(!autoLaunch, setAutoLaunch, { autoLaunch: !autoLaunch }, (v) => window.api.setAutoLaunch(v)))
          )}
          {renderSettingItem(
            t('settings.autoUpdate'),
            t('settings.autoUpdate.desc'),
            renderToggle(autoUpdate, () => applyToggle(!autoUpdate, setAutoUpdate, { autoUpdate: !autoUpdate }))
          )}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.behavior')}</h3>
          {renderSettingItem(
            t('settings.minTray'),
            t('settings.minTray.desc'),
            renderToggle(minimizeToTray, () => applyToggle(!minimizeToTray, setMinimizeToTray, { minimizeToTray: !minimizeToTray }, (v) => window.api.setMinimizeToTray(v)))
          )}
          {renderSettingItem(
            t('settings.closeTray'),
            t('settings.closeTray.desc'),
            renderToggle(closeToTray, () => applyToggle(!closeToTray, setCloseToTray, { closeToTray: !closeToTray }, (v) => window.api.setCloseToTray(v)))
          )}
        </div>
      </>
    );
  }

  function renderDownloadSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.downloads')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.downloads')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.location')}</h3>
          {renderSettingItem(
            t('settings.defaultDir'),
            t('settings.defaultDir.desc'),
            <Button variant="secondary" icon={<Icon name="folder-open" size={16} />} onClick={handleSelectDirectory}>
              {t('settings.choose')}
            </Button>
          )}
          {defaultDownloadDir && <div className="setting-value-display">{defaultDownloadDir}</div>}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.limits')}</h3>
          {renderSettingItem(
            t('settings.maxActive'),
            t('settings.maxActive.desc'),
            <input
              type="number"
              className="input-compact"
              min="1"
              max="10"
              value={maxActiveDownloads}
              onChange={(e) => setMaxActiveDownloads(parseInt(e.target.value) || 3)}
            />
          )}
        </div>

        <div className="settings-divider" />

        {/* Watch Folder */}
        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.watchFolder')}</h3>
          {renderSettingItem(
            t('settings.watchEnable'),
            t('settings.watchEnable.desc'),
            <button
              className={`toggle-switch ${watchFolderEnabled ? 'active' : ''}`}
              onClick={() => applyToggle(!watchFolderEnabled, setWatchFolderEnabled, { watchFolderEnabled: !watchFolderEnabled }, (v) => applyWatchFolder(v, watchFolderDeleteAfterAdd))}
            >
              <span className="toggle-slider" />
            </button>
          )}

          {watchFolderEnabled && (
            <>
              {renderSettingItem(
                t('settings.watchPath'),
                t('settings.watchPath.desc'),
                <div className="path-input-row">
                  <input
                    type="text"
                    className="input-compact input-path"
                    placeholder={t('settings.watchPath.placeholder')}
                    value={watchFolderPath}
                    onChange={e => setWatchFolderPath(e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="folder-open" size={14} />}
                    onClick={async () => {
                      const p = await window.api.selectDirectory();
                      if (p) setWatchFolderPath(p);
                    }}
                  />
                </div>
              )}
              {renderSettingItem(
                t('settings.watchDelete'),
                t('settings.watchDelete.desc'),
                <button
                  className={`toggle-switch ${watchFolderDeleteAfterAdd ? 'active' : ''}`}
                  onClick={() => applyToggle(!watchFolderDeleteAfterAdd, setWatchFolderDeleteAfterAdd, { watchFolderDeleteAfterAdd: !watchFolderDeleteAfterAdd }, (v) => applyWatchFolder(watchFolderEnabled, v))}
                >
                  <span className="toggle-slider" />
                </button>
              )}
            </>
          )}
        </div>

        <div className="settings-divider" />

        {/* Auto-move completed */}
        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.autoMove')}</h3>
          {renderSettingItem(
            t('settings.autoMove'),
            t('settings.autoMove.desc'),
            renderToggle(autoMoveEnabled, () =>
              applyToggle(!autoMoveEnabled, setAutoMoveEnabled, { autoMoveEnabled: !autoMoveEnabled })
            )
          )}
          {autoMoveEnabled && renderSettingItem(
            t('settings.autoMovePath'),
            t('settings.autoMovePath.desc'),
            <div className="path-input-row">
              <input
                type="text"
                className="input-compact input-path"
                placeholder={t('settings.autoMovePath.placeholder')}
                value={autoMovePath}
                onChange={e => setAutoMovePath(e.target.value)}
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="folder-open" size={14} />}
                onClick={async () => {
                  const p = await window.api.selectDirectory();
                  if (p) setAutoMovePath(p);
                }}
              />
            </div>
          )}
        </div>

        <div className="settings-divider" />

        {/* Disk-space guard */}
        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.diskGuard')}</h3>
          {renderSettingItem(
            t('settings.diskGuard'),
            t('settings.diskGuard.desc'),
            <button
              className={`toggle-switch ${diskGuardEnabled ? 'active' : ''}`}
              onClick={() => applyToggle(!diskGuardEnabled, setDiskGuardEnabled, { diskGuardEnabled: !diskGuardEnabled })}
            >
              <span className="toggle-slider" />
            </button>
          )}
          {diskGuardEnabled && renderSettingItem(
            t('settings.diskMin'),
            t('settings.diskMin.desc'),
            <div className="speed-input-compact">
              <input
                type="number"
                className="input-compact input-mono"
                min="100"
                step="256"
                value={diskGuardMinFreeMB}
                onChange={(e) => setDiskGuardMinFreeMB(parseInt(e.target.value) || 2048)}
              />
              <span className="input-unit">MB</span>
            </div>
          )}
        </div>
      </>
    );
  }

  function renderNetworkSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.network')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.network')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.speedLimits')}</h3>
          {renderSettingItem(
            t('settings.downSpeed'),
            t('settings.downSpeed.desc'),
            <div className="speed-input-compact">
              <input
                type="number"
                className="input-compact input-mono"
                min="0"
                value={maxDownKbps}
                onChange={(e) => setMaxDownKbps(parseInt(e.target.value) || 0)}
              />
              <span className="input-unit">KB/s</span>
            </div>
          )}
          {renderSettingItem(
            t('settings.upSpeed'),
            t('settings.upSpeed.desc'),
            <div className="speed-input-compact">
              <input
                type="number"
                className="input-compact input-mono"
                min="0"
                value={maxUpKbps}
                onChange={(e) => setMaxUpKbps(parseInt(e.target.value) || 0)}
              />
              <span className="input-unit">KB/s</span>
            </div>
          )}
        </div>

        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.speedNote')}</span>
        </div>

        <div className="settings-divider" />

        {/* Adaptive upload throttle — "smart" limit that needs no manual KB/s. */}
        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.smartLimit')}</h3>
          {renderSettingItem(
            t('settings.adaptiveUpload'),
            t('settings.adaptiveUpload.desc'),
            renderToggle(adaptiveUpload, () => applyToggle(!adaptiveUpload, setAdaptiveUpload, { adaptiveUpload: !adaptiveUpload }))
          )}
          {adaptiveUpload && renderAdaptiveHealth()}
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.adaptiveUpload.note')}</span>
          </div>
        </div>

        <div className="settings-divider" />

        {/* DNS-over-HTTPS */}
        {renderDohSection()}

        <div className="settings-divider" />

        {/* Smart network profiles */}
        {renderNetworkProfilesSection()}

        <div className="settings-divider" />

        {/* Alternative ("turbo"/turtle) speed limits */}
        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.altSpeed')}</h3>
          {renderSettingItem(
            t('settings.altSpeed'),
            t('settings.altSpeed.desc'),
            renderToggle(altSpeedEnabled, () =>
              applyToggle(!altSpeedEnabled, setAltSpeedEnabled, { altSpeedEnabled: !altSpeedEnabled }, (v) => window.api.setAltSpeed(v))
            )
          )}
          {renderSettingItem(
            t('settings.altDown'),
            t('settings.altDown.desc'),
            <div className="speed-input-compact">
              <input type="number" className="input-compact input-mono" min="0" value={altDownKbps}
                onChange={(e) => setAltDownKbps(parseInt(e.target.value) || 0)} />
              <span className="input-unit">KB/s</span>
            </div>
          )}
          {renderSettingItem(
            t('settings.altUp'),
            t('settings.altUp.desc'),
            <div className="speed-input-compact">
              <input type="number" className="input-compact input-mono" min="0" value={altUpKbps}
                onChange={(e) => setAltUpKbps(parseInt(e.target.value) || 0)} />
              <span className="input-unit">KB/s</span>
            </div>
          )}
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.altSpeed.note')}</span>
          </div>
        </div>

        {/* Proxy settings UI was removed: WebTorrent (the engine) has no proxy
            support, so the old section silently did nothing — worse than none,
            it gave a false sense of privacy. Bring it back only when traffic
            can actually be routed through a proxy. */}

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.sharing')}</h3>
          {renderSettingItem(
            t('settings.shareTurn'),
            t('settings.shareTurn.desc'),
            renderToggle(shareUseTurn, () => applyToggle(!shareUseTurn, setShareUseTurn, { shareUseTurn: !shareUseTurn }))
          )}
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.shareTurn.note')}</span>
          </div>

          {/* Optional user-supplied TURN relay (zero-cost ladder, last resort) */}
          <div className="doh-add">
            <div className="doh-add-title">{t('settings.customTurn.title')}</div>
            <div className="doh-add-row">
              <input
                className="input-compact input-mono"
                style={{ flex: 2 }}
                placeholder="turn:relay.example.com:3478"
                value={turnUrl}
                onChange={(e) => setTurnUrl(e.target.value)}
              />
              <input
                className="input-compact"
                style={{ flex: 1 }}
                placeholder={t('settings.customTurn.user')}
                value={turnUser}
                onChange={(e) => setTurnUser(e.target.value)}
              />
              <input
                className="input-compact"
                style={{ flex: 1 }}
                type="password"
                placeholder={t('settings.customTurn.pass')}
                value={turnCred}
                onChange={(e) => setTurnCred(e.target.value)}
              />
              <Button variant="secondary" size="sm" onClick={saveTurn} loading={turnSaving} icon={<Icon name="check" size={14} />}>
                {t('common.save')}
              </Button>
            </div>
            <div className="settings-notice-compact">
              <Icon name="info" size={14} />
              <span>{t('settings.customTurn.note')}</span>
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        {/* Mobile web remote */}
        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.webRemote')}</h3>
          {renderSettingItem(
            t('settings.webRemote'),
            t('settings.webRemote.desc'),
            renderToggle(webRemote.enabled, async () => {
              const info = await window.api.webRemote.setEnabled(!webRemote.enabled);
              setWebRemote(info);
            })
          )}

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
        </div>
      </>
    );
  }

  function renderAdvancedSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.advanced')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.advanced')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.protocols')}</h3>
          {renderSettingItem(
            t('settings.dht'),
            t('settings.dht.desc'),
            renderToggle(enableDHT, () => applyToggle(!enableDHT, setEnableDHT, { enableDHT: !enableDHT }))
          )}
          {renderSettingItem(
            t('settings.utp'),
            t('settings.utp.desc'),
            renderToggle(enableUtp, () => applyToggle(!enableUtp, setEnableUtp, { enableUtp: !enableUtp }))
          )}
          {/* PEX/LSD toggles removed: WebTorrent can't switch PEX off and has
              no LSD implementation — the switches were placebo. */}
          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.protocols.note')}</span>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.connections')}</h3>
          {renderSettingItem(
            t('settings.maxConn'),
            t('settings.maxConn.desc'),
            <input
              type="number"
              className="input-compact input-mono"
              min="10"
              max="500"
              value={maxConnections}
              onChange={(e) => setMaxConnections(parseInt(e.target.value) || 55)}
            />
          )}
          {renderSettingItem(
            t('settings.maxConnGlobal'),
            t('settings.maxConnGlobal.desc'),
            <input
              type="number"
              className="input-compact input-mono"
              min="20"
              max="2000"
              value={maxConnectionsGlobal}
              onChange={(e) => setMaxConnectionsGlobal(parseInt(e.target.value) || 200)}
            />
          )}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.ports')}</h3>
          {/* WebTorrent listens on ONE port, not a range — show a single field
              (persisted as portMin for backwards compatibility). */}
          {renderSettingItem(
            t('settings.port'),
            t('settings.port.desc'),
            <input
              type="number"
              className="input-compact input-mono"
              min="1024"
              max="65535"
              value={portMin}
              onChange={(e) => setPortMin(parseInt(e.target.value) || 6881)}
            />
          )}
          {renderSettingItem(
            t('settings.portForward'),
            t('settings.portForward.desc'),
            renderToggle(portForwarding, () => applyToggle(!portForwarding, setPortForwarding, { portForwarding: !portForwarding }))
          )}
          {portForwarding && (
            <div className="setting-item">
              <div className="setting-info">
                <div className="setting-label">{t('settings.portForward.status')}</div>
                <p className="setting-description">{t('settings.portForward.statusDesc')}</p>
              </div>
              <div className="setting-control">{renderPfStatus()}</div>
            </div>
          )}
        </div>

        <div className="settings-notice-compact">
          <Icon name="info" size={14} />
          <span>{t('settings.advanced.restartNote')}</span>
        </div>
      </>
    );
  }

  // Coloured status pill for UPnP port forwarding.
  function renderPfStatus() {
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
    const tk = t as (k: string) => string; // m.key is built at runtime
    return (
      <span
        className={`privacy-status ${m.cls}`}
        title={pfStatus?.error || (pfStatus?.externalIp ? `${t('settings.pf.externalIp')}: ${pfStatus.externalIp}` : '')}
      >
        <Icon name={m.icon} size={14} /> {tk(m.key)}{portTxt}
      </span>
    );
  }

  // Live indicator for the adaptive upload throttle: shows the control loop's
  // current latency vs its unloaded baseline, the cap it has settled on, and the
  // upload rate flowing through it — so the user can watch it adapt in real time.
  function renderAdaptiveHealth() {
    const a = netHealth?.adaptive;
    const tk = t as (k: string) => string;
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
  }

  // DNS-over-HTTPS resolver picker + custom-template management.
  function renderDohSection() {
    return (
      <div className="settings-group">
        <h3 className="settings-group-title">{t('settings.grp.doh')}</h3>
        {renderSettingItem(
          t('settings.doh'),
          t('settings.doh.desc'),
          renderToggle(dohEnabled, () => applyToggle(!dohEnabled, setDohEnabled, { dohEnabled: !dohEnabled }))
        )}

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
      </div>
    );
  }

  // Smart network profiles: auto-apply a settings overlay per network.
  function renderNetworkProfilesSection() {
    const overrideSummary = (p: NetworkProfile): string => {
      const o = p.overrides; const parts: string[] = [];
      if (o.maxDownKbps !== undefined) parts.push(`↓ ${o.maxDownKbps || '∞'}`);
      if (o.maxUpKbps !== undefined) parts.push(`↑ ${o.maxUpKbps || '∞'}`);
      if (o.maxConnectionsGlobal !== undefined) parts.push(`${o.maxConnectionsGlobal} conn`);
      if (o.adaptiveUpload !== undefined) parts.push(`adaptive ${o.adaptiveUpload ? 'on' : 'off'}`);
      if (o.dohEnabled !== undefined) parts.push(`DoH ${o.dohEnabled ? 'on' : 'off'}`);
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
              <input type="number" className="input-compact input-mono" min="0" value={o[key] as number}
                onChange={(e) => setOverrideValue(key, parseInt(e.target.value) || 0)} />
              {unit && <span className="input-unit">{unit}</span>}
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
          {on && renderToggle(!!o[key], () => setOverrideValue(key, !o[key]))}
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
      <div className="settings-group">
        <h3 className="settings-group-title">{t('settings.grp.netProfiles')}</h3>
        {renderSettingItem(
          t('settings.net'),
          t('settings.net.desc'),
          renderToggle(netEnabled, () => applyToggle(!netEnabled, setNetEnabled, { networkProfilesEnabled: !netEnabled }))
        )}

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
      </div>
    );
  }

  function renderPrivacySettings() {
    return <PrivacySettings />;
  }



  function renderSchedulerSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.scheduler')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.scheduler')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.scheduler')}</h3>
          {renderSettingItem(
            t('settings.schedEnable'),
            t('settings.schedEnable.desc'),
            renderToggle(schedulerEnabled, () => handleSchedulerToggle())
          )}
        </div>

        {schedulerEnabled && (
          <>
            <div className="settings-divider" />
            <div className="settings-group">
              <div className="settings-group-header">
                <h3 className="settings-group-title">{t('settings.grp.schedules')}</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Icon name="plus" size={14} />}
                  onClick={handleAddSchedule}
                >
                  {t('settings.add')}
                </Button>
              </div>

              {schedules.length === 0 ? (
                <div className="empty-state-compact">
                  <Icon name="calendar" size={24} />
                  <p>{t('settings.noSchedules')}</p>
                </div>
              ) : (
                <div className="schedule-list">
                  {schedules.map((schedule) => (
                    <div key={schedule.id} className="schedule-entry-compact">
                      <div className="schedule-days-compact">
                        {dayNames.map((day, idx) => (
                          <button
                            key={idx}
                            className={`day-button ${schedule.days.includes(idx) ? 'active' : ''}`}
                            onClick={() => {
                              const newDays = schedule.days.includes(idx)
                                ? schedule.days.filter((d) => d !== idx)
                                : [...schedule.days, idx].sort();
                              handleUpdateSchedule(schedule.id, { days: newDays });
                            }}
                          >
                            {day}
                          </button>
                        ))}
                      </div>
                      <div className="schedule-time-compact">
                        <input
                          type="time"
                          className="time-input-compact"
                          value={schedule.startTime}
                          onChange={(e) =>
                            handleUpdateSchedule(schedule.id, { startTime: e.target.value })
                          }
                        />
                        <span className="time-separator">—</span>
                        <input
                          type="time"
                          className="time-input-compact"
                          value={schedule.endTime}
                          onChange={(e) =>
                            handleUpdateSchedule(schedule.id, { endTime: e.target.value })
                          }
                        />
                      </div>
                      <button
                        className="button-icon-compact"
                        onClick={() => handleRemoveSchedule(schedule.id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </>
    );
  }

  function renderSeedingSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.hdr.seeding')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.seeding')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.seedingLimits')}</h3>
          <p className="settings-group-desc">
            {t('settings.seedGlobalNote')}
          </p>

          {renderSettingItem(
            t('settings.seedRatio'),
            t('settings.seedRatio.desc'),
            <div className="speed-input-compact">
              <input
                type="number"
                className="input-compact input-mono"
                min="0"
                step="0.1"
                placeholder="0"
                value={defaultSeedRatioLimit}
                onChange={e => setDefaultSeedRatioLimit(parseFloat(e.target.value) || 0)}
              />
              <span className="input-unit">{t('settings.unit.ratio')}</span>
            </div>
          )}

          {renderSettingItem(
            t('settings.seedTime'),
            t('settings.seedTime.desc'),
            <div className="speed-input-compact">
              <input
                type="number"
                className="input-compact input-mono"
                min="0"
                step="5"
                placeholder="0"
                value={defaultSeedTimeLimitMinutes}
                onChange={e => setDefaultSeedTimeLimitMinutes(parseInt(e.target.value) || 0)}
              />
              <span className="input-unit">{t('settings.unit.min')}</span>
            </div>
          )}

          {(defaultSeedRatioLimit > 0 || defaultSeedTimeLimitMinutes > 0) && (
            <div className="setting-info-box">
              <Icon name="info" size={14} />
              <span>
                {t('settings.seedStopWhen')}{' '}
                {defaultSeedRatioLimit > 0 && <><strong>{t('settings.seedRatioReached')} {defaultSeedRatioLimit}</strong></>}
                {defaultSeedRatioLimit > 0 && defaultSeedTimeLimitMinutes > 0 && ` ${t('settings.or')} `}
                {defaultSeedTimeLimitMinutes > 0 && <><strong>{defaultSeedTimeLimitMinutes} {t('settings.seedMinElapsed')}</strong></>}
              </span>
            </div>
          )}
        </div>
      </>
    );
  }


  function renderInterfaceSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.hdr.interface')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.interface')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.theme')}</h3>
          <div className="setting-item setting-item-stacked">
            <div className="setting-info">
              <div className="setting-label">{t('settings.theme')}</div>
              <p className="setting-description">{t('settings.theme.desc')}</p>
            </div>
            <div className="setting-control">
              <ThemeSelector currentTheme={theme} onThemeChange={handleThemeChange} />
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.language')}</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{t('settings.language')}</div>
              <p className="setting-description">{t('settings.language.desc')}</p>
            </div>
            <div className="setting-control" style={{ width: '150px' }}>
              <Select 
                options={[
                  { value: 'en', label: 'English', icon: 'globe' },
                  { value: 'ru', label: 'Русский', icon: 'globe' }
                ]}
                value={language}
                onChange={(val) => setLanguage(val as 'en' | 'ru')}
              />
            </div>
          </div>
        </div>
      </>
    );
  }

  function renderNotificationSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.notifications')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.notifications')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.notifications')}</h3>
          {renderSettingItem(
            t('settings.notif.enable'),
            t('settings.notif.enable.desc'),
            renderToggle(enableNotifications, () => applyToggle(!enableNotifications, setEnableNotifications, { enableNotifications: !enableNotifications }))
          )}
          {renderSettingItem(
            t('settings.notif.sounds'),
            t('settings.notif.sounds.desc'),
            renderToggle(enableSounds, () => applyToggle(!enableSounds, setEnableSounds, { enableSounds: !enableSounds }))
          )}
          {renderSettingItem(
            t('settings.notif.complete'),
            t('settings.notif.complete.desc'),
            renderToggle(notifyOnComplete, () => applyToggle(!notifyOnComplete, setNotifyOnComplete, { notifyOnComplete: !notifyOnComplete }))
          )}
          {renderSettingItem(
            t('settings.notif.error'),
            t('settings.notif.error.desc'),
            renderToggle(notifyOnError, () => applyToggle(!notifyOnError, setNotifyOnError, { notifyOnError: !notifyOnError }))
          )}
        </div>
      </>
    );
  }

  function renderSystemSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.hdr.system')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.system')}</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.osIntegration')}</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{t('settings.defaultClient')}</div>
              <p className="setting-description">{t('settings.defaultClient.desc')}</p>
            </div>
            <div className="setting-control">
              {isDefaultClient ? (
                <span className="status-badge success" style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                  <Icon name="check-circle" size={14} />
                  {t('settings.currentDefault')}
                </span>
              ) : (
                <Button variant="secondary" onClick={handleSetDefaultClient}>
                  {t('settings.setDefault')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.updates')}</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{updateReady ? t('settings.updateReady') : t('settings.checkUpdates')}</div>
              <p className="setting-description">
                {updateReady
                  ? `${t('settings.versionWord')} ${updateReady} ${t('settings.downloadedRestart')}`
                  : t('settings.checkUpdatesDesc')}
              </p>
            </div>
            <div className="setting-control">
              {updateReady ? (
                <Button
                  variant="primary"
                  icon={<Icon name="refresh" size={16} />}
                  onClick={() => window.api.quitAndInstallUpdate()}
                >
                  {t('settings.restartInstall')}
                </Button>
              ) : (
                <Button variant="secondary" onClick={handleCheckForUpdates}>
                  {t('settings.checkNow')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.maintenance')}</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{t('settings.clearCache')}</div>
              <p className="setting-description">{t('settings.clearCache.desc')}</p>
            </div>
            <div className="setting-control">
              <Button
                variant="secondary"
                icon={<Icon name="trash" size={16} />}
                onClick={handleClearCache}
                loading={clearingCache}
                disabled={clearingCache}
              >
                {t('settings.clear')}
              </Button>
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.backup')}</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{t('settings.exportSettings')}</div>
              <p className="setting-description">{t('settings.exportSettings.desc')}</p>
            </div>
            <div className="setting-control">
              <Button variant="secondary" onClick={handleExportSettings}>
                {t('settings.export')}
              </Button>
            </div>
          </div>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{t('settings.importSettings')}</div>
              <p className="setting-description">{t('settings.importSettings.desc')}</p>
            </div>
            <div className="setting-control">
              <Button variant="secondary" onClick={handleImportSettings}>
                {t('settings.import')}
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  function renderAboutSettings() {
    return (
      <AboutSection
        appVersion={appVersion}
        updateReady={updateReady}
        isDefaultClient={isDefaultClient}
        setIsDefaultClient={setIsDefaultClient}
        stats={stats}
      />
    );
  }
};

export default SettingsPage;
