/**
 * Settings Page - Professional Desktop Design 2026
 * 
 * Complete redesign with sidebar navigation and semantic grouping.
 */

import React, { useState, useEffect } from 'react';
import { AppSettings, SchedulerConfig, ScheduleEntry } from '../../shared/types';
import {
  Button,
  Icon,
  Select,
  Alert,
  ThemeSelector,
  AppStatistics,
  SettingsSidebar,
  SettingsCategory,
} from '../components';
import { PrivacySettings } from '../components/PrivacySettings';
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
  const [maxActiveDownloads, setMaxActiveDownloads] = useState(3);

  // Proxy settings
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyType, setProxyType] = useState<'http' | 'https' | 'socks5'>('http');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState(8080);
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');

  // Advanced settings
  const [enableDHT, setEnableDHT] = useState(true);
  const [enablePEX, setEnablePEX] = useState(true);
  const [enableLSD, setEnableLSD] = useState(true);
  const [maxConnections, setMaxConnections] = useState(100);
  const [portMin, setPortMin] = useState(6881);
  const [portMax, setPortMax] = useState(6889);

  // Watch folder settings
  const [watchFolderEnabled, setWatchFolderEnabled] = useState(false);
  const [watchFolderPath, setWatchFolderPath] = useState('');
  const [watchFolderDeleteAfterAdd, setWatchFolderDeleteAfterAdd] = useState(false);

  // Disk-space guard
  const [diskGuardEnabled, setDiskGuardEnabled] = useState(true);
  const [diskGuardMinFreeMB, setDiskGuardMinFreeMB] = useState(2048);

  // Sharing
  const [shareUseTurn, setShareUseTurn] = useState(true);

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
      maxActiveDownloads !== s.maxActiveDownloads ||
      // Advanced
      maxConnections !== s.maxConnections ||
      portMin !== s.portMin ||
      portMax !== s.portMax ||
      // Proxy
      proxyType !== s.proxyType ||
      proxyHost !== s.proxyHost ||
      proxyPort !== s.proxyPort ||
      proxyUsername !== s.proxyUsername ||
      proxyPassword !== s.proxyPassword ||
      // Watch folder
      watchFolderPath !== s.watchFolderPath ||
      // Disk guard
      diskGuardMinFreeMB !== (s.diskGuardMinFreeMB ?? 2048) ||
      // Seeding
      defaultSeedRatioLimit !== s.defaultSeedRatioLimit ||
      defaultSeedTimeLimitMinutes !== s.defaultSeedTimeLimitMinutes;
    setHasChanges(changed);
  }, [
    settings, defaultDownloadDir, maxDownKbps, maxUpKbps, maxActiveDownloads,
    maxConnections, portMin, portMax,
    proxyType, proxyHost, proxyPort, proxyUsername, proxyPassword,
    watchFolderPath, diskGuardMinFreeMB,
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
      setMaxActiveDownloads(s.maxActiveDownloads);
      setMinimizeToTray(s.minimizeToTray ?? false);
      setCloseToTray(s.closeToTray ?? false);

      // Advanced settings
      setEnableDHT(s.enableDHT ?? true);
      setEnablePEX(s.enablePEX ?? true);
      setEnableLSD(s.enableLSD ?? true);
      setMaxConnections(s.maxConnections ?? 100);
      setPortMin(s.portMin ?? 6881);
      setPortMax(s.portMax ?? 6889);

      // Proxy settings
      setProxyEnabled(s.proxyEnabled ?? false);
      setProxyType(s.proxyType ?? 'http');
      setProxyHost(s.proxyHost ?? '');
      setProxyPort(s.proxyPort ?? 8080);
      setProxyUsername(s.proxyUsername ?? '');
      setProxyPassword(s.proxyPassword ?? '');

      // Watch folder
      setWatchFolderEnabled(s.watchFolderEnabled ?? false);
      setWatchFolderPath(s.watchFolderPath ?? '');
      setWatchFolderDeleteAfterAdd(s.watchFolderDeleteAfterAdd ?? false);

      // Disk-space guard
      setDiskGuardEnabled(s.diskGuardEnabled ?? true);
      setDiskGuardMinFreeMB(s.diskGuardMinFreeMB ?? 2048);

      // Sharing
      setShareUseTurn(s.shareUseTurn ?? true);

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
        maxActiveDownloads,
        minimizeToTray,
        closeToTray,
        // Advanced
        enableDHT,
        enablePEX,
        enableLSD,
        maxConnections,
        portMin,
        portMax,
        // Proxy
        proxyEnabled,
        proxyType,
        proxyHost,
        proxyPort,
        proxyUsername,
        proxyPassword,
        // Watch folder
        watchFolderEnabled,
        watchFolderPath,
        watchFolderDeleteAfterAdd,
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
      setMaxActiveDownloads(settings.maxActiveDownloads);
      setMaxConnections(settings.maxConnections ?? 100);
      setPortMin(settings.portMin ?? 6881);
      setPortMax(settings.portMax ?? 6889);
      setProxyType(settings.proxyType ?? 'http');
      setProxyHost(settings.proxyHost ?? '');
      setProxyPort(settings.proxyPort ?? 8080);
      setProxyUsername(settings.proxyUsername ?? '');
      setProxyPassword(settings.proxyPassword ?? '');
      setWatchFolderPath(settings.watchFolderPath ?? '');
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

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.proxy')}</h3>
          {renderSettingItem(
            t('settings.proxyEnable'),
            t('settings.proxyEnable.desc'),
            renderToggle(proxyEnabled, () => applyToggle(!proxyEnabled, setProxyEnabled, { proxyEnabled: !proxyEnabled }))
          )}
          {proxyEnabled && (
            <>
              {renderSettingItem(
                t('settings.proxyType'),
                t('settings.proxyType.desc'),
                <select
                  className="input-compact"
                  value={proxyType}
                  onChange={(e) => setProxyType(e.target.value as any)}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              )}
              {renderSettingItem(
                t('settings.proxyHost'),
                t('settings.proxyHost.desc'),
                <input
                  type="text"
                  className="input-compact"
                  placeholder="proxy.example.com"
                  value={proxyHost}
                  onChange={(e) => setProxyHost(e.target.value)}
                />
              )}
              {renderSettingItem(
                t('settings.proxyPort'),
                t('settings.proxyPort.desc'),
                <input
                  type="number"
                  className="input-compact input-mono"
                  min="1"
                  max="65535"
                  value={proxyPort}
                  onChange={(e) => setProxyPort(parseInt(e.target.value) || 8080)}
                />
              )}
              {renderSettingItem(
                t('settings.proxyUser'),
                t('settings.proxyUser.desc'),
                <input
                  type="text"
                  className="input-compact"
                  placeholder="username"
                  value={proxyUsername}
                  onChange={(e) => setProxyUsername(e.target.value)}
                />
              )}
              {renderSettingItem(
                t('settings.proxyPass'),
                t('settings.proxyPass.desc'),
                <input
                  type="password"
                  className="input-compact"
                  placeholder="••••••"
                  value={proxyPassword}
                  onChange={(e) => setProxyPassword(e.target.value)}
                />
              )}
              <div className="settings-notice-compact">
                <Icon name="info" size={14} />
                <span>{t('settings.proxyNote')}</span>
              </div>
            </>
          )}
        </div>

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
            t('settings.pex'),
            t('settings.pex.desc'),
            renderToggle(enablePEX, () => applyToggle(!enablePEX, setEnablePEX, { enablePEX: !enablePEX }))
          )}
          {renderSettingItem(
            t('settings.lsd'),
            t('settings.lsd.desc'),
            renderToggle(enableLSD, () => applyToggle(!enableLSD, setEnableLSD, { enableLSD: !enableLSD }))
          )}
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
              onChange={(e) => setMaxConnections(parseInt(e.target.value) || 100)}
            />
          )}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">{t('settings.grp.ports')}</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">{t('settings.portRange')}</div>
              <p className="setting-description">{t('settings.portRange.desc')}</p>
            </div>
            <div className="setting-control">
              <div className="port-range-input">
                <input
                  type="number"
                  className="input-compact input-mono"
                  min="1024"
                  max="65535"
                  value={portMin}
                  onChange={(e) => setPortMin(parseInt(e.target.value) || 6881)}
                />
                <span className="port-separator">—</span>
                <input
                  type="number"
                  className="input-compact input-mono"
                  min="1024"
                  max="65535"
                  value={portMax}
                  onChange={(e) => setPortMax(parseInt(e.target.value) || 6889)}
                />
              </div>
            </div>
          </div>
        </div>
      </>
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
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">{t('settings.hdr.about')}</h1>
          <p className="settings-category-subtitle">{t('settings.sub.about')}</p>
        </div>

        <div className="about-section">
          <div className="about-app">
            <div className="about-icon"><Icon name="download" size={28} /></div>
            <div className="about-info-text">
              <h2 className="about-app-name">TorrentHunt</h2>
              <p className="about-version">{t('settings.version')} {appVersion || '—'}</p>
              <p className="about-description">
                {t('settings.appDesc')}
              </p>
            </div>
          </div>

          <div className="settings-divider" />

          <div className="settings-group">
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
  }
};

export default SettingsPage;
