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
  Alert,
  ThemeSelector,
  SpeedPresets,
  NotificationSettings,
  HotkeySettings,
  defaultHotkeys,
  SystemSettings,
  ProxySettings,
  AdvancedSettings,
  SettingsBackup,
  AppStatistics,
  SettingsSidebar,
  SettingsCategory,
  SeedingDashboard,
} from '../components';
import { PrivacySettings } from '../components/PrivacySettings';
import './SettingsPage.css';
import { v4 as uuidv4 } from 'uuid';

type Theme = 'light' | 'dark' | 'system';

const SettingsPage: React.FC = () => {
  // Active category
  const [activeCategory, setActiveCategory] = useState('general');

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

  // Scheduler state
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig | null>(null);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);

  // Hotkeys
  const [hotkeys, setHotkeys] = useState(defaultHotkeys);

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
    { id: 'general', label: 'General', icon: 'settings', group: 'core' },
    { id: 'downloads', label: 'Downloads', icon: 'download', group: 'core' },
    { id: 'network', label: 'Network', icon: 'activity', group: 'core' },
    
    // Advanced
    { id: 'advanced', label: 'Advanced', icon: 'layers', group: 'advanced' },
    { id: 'privacy', label: 'Privacy', icon: 'shield', group: 'advanced' },
    { id: 'scheduler', label: 'Scheduler', icon: 'calendar', group: 'advanced' },
    { id: 'seeding', label: 'Collaborative Seeding', icon: 'share-2', group: 'advanced' },

    // Appearance
    { id: 'interface', label: 'Interface', icon: 'sun', group: 'appearance' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', group: 'appearance' },
    
    // System
    { id: 'system', label: 'System', icon: 'power', group: 'system' },
    { id: 'hotkeys', label: 'Hotkeys', icon: 'keyboard', group: 'system' },
    
    // Other
    { id: 'about', label: 'About', icon: 'info', group: 'other' },
  ];

  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  useEffect(() => {
    loadSettings();
    loadStats();
    const savedTheme = localStorage.getItem('theme') as Theme || 'system';
    setTheme(savedTheme);
    applyTheme(savedTheme);
    
    // Load saved hotkeys
    try {
      const savedHotkeys = localStorage.getItem('hotkeys');
      if (savedHotkeys) {
        const hotkeysMap = JSON.parse(savedHotkeys);
        const updatedHotkeys = defaultHotkeys.map(h => ({
          ...h,
          keys: hotkeysMap[h.id] || h.keys
        }));
        setHotkeys(updatedHotkeys);
      }
    } catch (error) {
      console.error('Failed to load hotkeys:', error);
    }
  }, []);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  useEffect(() => {
    if (settings) {
      const changed =
        defaultDownloadDir !== settings.defaultDownloadDir ||
        maxDownKbps !== settings.maxDownKbps ||
        maxUpKbps !== settings.maxUpKbps ||
        maxActiveDownloads !== settings.maxActiveDownloads;
      setHasChanges(changed);
    }
  }, [settings, defaultDownloadDir, maxDownKbps, maxUpKbps, maxActiveDownloads]);

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

      const scheduler = await window.api.getScheduler();
      setSchedulerConfig(scheduler);
      setSchedulerEnabled(scheduler.enabled);
      setSchedules(scheduler.schedules);
    } catch (error) {
      console.error('Failed to load settings:', error);
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    // Mock stats - в реальном приложении получать через API
    setStats({
      totalDownloads: 42,
      totalUploaded: '15.3 GB',
      totalDownloaded: '47.8 GB',
      cacheSize: '234 MB',
      diskUsage: '47.8 GB',
      uptime: '3h 24m',
    });
  };

  const handleSchedulerToggle = async () => {
    try {
      const newEnabled = !schedulerEnabled;
      await window.api.updateScheduler({ enabled: newEnabled });
      setSchedulerEnabled(newEnabled);
      setMessage({ type: 'success', text: newEnabled ? 'Планировщик включен' : 'Планировщик выключен' });
    } catch (error) {
      console.error('Failed to toggle scheduler:', error);
      setMessage({ type: 'error', text: 'Failed to toggle scheduler' });
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

  const handleSave = async () => {
    if (!settings) return;

    setSaving(true);
    try {
      await window.api.updateSettings({
        defaultDownloadDir,
        maxDownKbps,
        maxUpKbps,
        maxActiveDownloads,
      });

      if (schedulerConfig) {
        await window.api.updateScheduler({
          enabled: schedulerEnabled,
          schedules,
        });
      }

      setMessage({ type: 'success', text: 'Настройки успешно сохранены!' });
      setHasChanges(false);
      await loadSettings();
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: 'Не удалось сохранить настройки' });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (settings) {
      setDefaultDownloadDir(settings.defaultDownloadDir);
      setMaxDownKbps(settings.maxDownKbps);
      setMaxUpKbps(settings.maxUpKbps);
      setMaxActiveDownloads(settings.maxActiveDownloads);
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
      // Mock - implement actual cache clearing later
      await new Promise(resolve => setTimeout(resolve, 1000));
      setMessage({ type: 'success', text: 'Кеш успешно очищен!' });
    } catch (error) {
      console.error('Failed to clear cache:', error);
      setMessage({ type: 'error', text: 'Не удалось очистить кеш' });
    } finally {
      setClearingCache(false);
    }
  };

  const handleSpeedChange = (download: number, upload: number) => {
    setMaxDownKbps(download);
    setMaxUpKbps(upload);
  };

  const handleNotificationChange = (notifSettings: {
    enableNotifications: boolean;
    enableSounds: boolean;
    notifyOnComplete: boolean;
    notifyOnError: boolean;
  }) => {
    setEnableNotifications(notifSettings.enableNotifications);
    setEnableSounds(notifSettings.enableSounds);
    setNotifyOnComplete(notifSettings.notifyOnComplete);
    setNotifyOnError(notifSettings.notifyOnError);
  };

  const handleHotkeyChange = (hotkeyId: string, keys: string[]) => {
    const updatedHotkeys = hotkeys.map((h) => (h.id === hotkeyId ? { ...h, keys } : h));
    setHotkeys(updatedHotkeys);
    
    // Save to localStorage
    const hotkeysMap: Record<string, string[]> = {};
    updatedHotkeys.forEach(h => {
      hotkeysMap[h.id] = h.keys;
    });
    localStorage.setItem('hotkeys', JSON.stringify(hotkeysMap));
  };

  const handleResetHotkeys = () => {
    setHotkeys([...defaultHotkeys]);
    
    // Save default to localStorage
    const hotkeysMap: Record<string, string[]> = {};
    defaultHotkeys.forEach(h => {
      hotkeysMap[h.id] = h.keys;
    });
    localStorage.setItem('hotkeys', JSON.stringify(hotkeysMap));
    
    setMessage({ type: 'success', text: 'Горячие клавиши сброшены!' });
  };

  const handleProxyChange = (proxy: {
    enabled: boolean;
    type: 'http' | 'https' | 'socks5';
    host: string;
    port: number;
    username: string;
    password: string;
  }) => {
    setProxyEnabled(proxy.enabled);
    setProxyType(proxy.type);
    setProxyHost(proxy.host);
    setProxyPort(proxy.port);
    setProxyUsername(proxy.username);
    setProxyPassword(proxy.password);
  };

  const handleAdvancedChange = (advanced: {
    enableDHT: boolean;
    enablePEX: boolean;
    enableLSD: boolean;
    maxConnections: number;
    portMin: number;
    portMax: number;
  }) => {
    setEnableDHT(advanced.enableDHT);
    setEnablePEX(advanced.enablePEX);
    setEnableLSD(advanced.enableLSD);
    setMaxConnections(advanced.maxConnections);
    setPortMin(advanced.portMin);
    setPortMax(advanced.portMax);
  };

  const handleExportSettings = async () => {
    try {
      // Mock - implement actual export later
      await new Promise(resolve => setTimeout(resolve, 500));
      setMessage({ type: 'success', text: 'Настройки экспортированы!' });
    } catch (error) {
      console.error('Failed to export settings:', error);
      setMessage({ type: 'error', text: 'Ошибка экспорта настроек' });
    }
  };

  const handleImportSettings = async () => {
    try {
      // Mock - implement actual import later
      await new Promise(resolve => setTimeout(resolve, 500));
      await loadSettings();
      setMessage({ type: 'success', text: 'Настройки импортированы!' });
    } catch (error) {
      console.error('Failed to import settings:', error);
      setMessage({ type: 'error', text: 'Ошибка импорта настроек' });
    }
  };

  const handleCheckForUpdates = async () => {
    try {
      // Mock - implement actual update check later
      await new Promise(resolve => setTimeout(resolve, 500));
      setMessage({ type: 'success', text: 'Проверка обновлений запущена' });
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  };

  if (loading) {
    return (
      <div className="settings-page settings-loading">
        <Icon name="loader" size={32} />
        <p>Загрузка настроек...</p>
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
              Отменить
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={saving}>
              Сохранить изменения
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
      case 'hotkeys':
        return renderHotkeySettings();
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
          <h1 className="settings-category-title">General</h1>
          <p className="settings-category-subtitle">Basic application configuration</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">APPLICATION</h3>
          {renderSettingItem(
            'Auto Launch',
            'Start TorrentHunt when system boots',
            renderToggle(autoLaunch, () => setAutoLaunch(!autoLaunch))
          )}
          {renderSettingItem(
            'Auto Update',
            'Automatically download and install updates',
            renderToggle(autoUpdate, () => setAutoUpdate(!autoUpdate))
          )}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">BEHAVIOR</h3>
          {renderSettingItem(
            'Minimize to Tray',
            'Keep app running in system tray when minimized',
            renderToggle(minimizeToTray, () => setMinimizeToTray(!minimizeToTray))
          )}
          {renderSettingItem(
            'Close to Tray',
            'Hide window instead of quitting when closing',
            renderToggle(closeToTray, () => setCloseToTray(!closeToTray))
          )}
        </div>
      </>
    );
  }

  function renderDownloadSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">Downloads</h1>
          <p className="settings-category-subtitle">Manage download location and behavior</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">LOCATION</h3>
          {renderSettingItem(
            'Default Directory',
            'Where to save downloaded files',
            <Button variant="secondary" icon={<Icon name="folder-open" size={16} />} onClick={handleSelectDirectory}>
              Choose
            </Button>
          )}
          {defaultDownloadDir && <div className="setting-value-display">{defaultDownloadDir}</div>}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">LIMITS</h3>
          {renderSettingItem(
            'Maximum Active Downloads',
            'How many torrents can download simultaneously',
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
      </>
    );
  }

  function renderNetworkSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">Network</h1>
          <p className="settings-category-subtitle">Download and upload speed, connections, ports</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">SPEED LIMITS</h3>
          {renderSettingItem(
            'Download Speed',
            'Set maximum download speed (0 = unlimited)',
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
            'Upload Speed',
            'Set maximum upload speed (0 = unlimited)',
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
          <span>Speed limiting is best-effort due to WebTorrent limitations</span>
        </div>
      </>
    );
  }

  function renderAdvancedSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">Advanced</h1>
          <p className="settings-category-subtitle">Protocols, connections, and technical settings</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">PROTOCOLS</h3>
          {renderSettingItem(
            'Enable DHT',
            'Distributed Hash Table for peer discovery',
            renderToggle(enableDHT, () => setEnableDHT(!enableDHT))
          )}
          {renderSettingItem(
            'Enable PEX',
            'Peer Exchange for peer discovery',
            renderToggle(enablePEX, () => setEnablePEX(!enablePEX))
          )}
          {renderSettingItem(
            'Enable LSD',
            'Local Service Discovery',
            renderToggle(enableLSD, () => setEnableLSD(!enableLSD))
          )}
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">CONNECTIONS</h3>
          {renderSettingItem(
            'Maximum Connections',
            'Per torrent connection limit',
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
          <h3 className="settings-group-title">PORT CONFIGURATION</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">Listening Port Range</div>
              <p className="setting-description">Port range for incoming connections</p>
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
          <h1 className="settings-category-title">Scheduler</h1>
          <p className="settings-category-subtitle">Schedule when downloads are active</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">SCHEDULER</h3>
          {renderSettingItem(
            'Enable Scheduler',
            'Downloads will only be active during specified times',
            renderToggle(schedulerEnabled, () => handleSchedulerToggle())
          )}
        </div>

        {schedulerEnabled && (
          <>
            <div className="settings-divider" />
            <div className="settings-group">
              <div className="settings-group-header">
                <h3 className="settings-group-title">SCHEDULES</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Icon name="plus" size={14} />}
                  onClick={handleAddSchedule}
                >
                  Add
                </Button>
              </div>

              {schedules.length === 0 ? (
                <div className="empty-state-compact">
                  <Icon name="calendar" size={24} />
                  <p>No schedules yet. Add your first one!</p>
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
    return <SeedingDashboard />;
  }

  function renderInterfaceSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">Interface & Themes</h1>
          <p className="settings-category-subtitle">Customize appearance and visual style</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">THEME</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">Color Scheme</div>
              <p className="setting-description">Choose your preferred theme</p>
            </div>
            <div className="setting-control">
              <ThemeSelector currentTheme={theme} onThemeChange={handleThemeChange} />
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
          <h1 className="settings-category-title">Notifications</h1>
          <p className="settings-category-subtitle">Configure notification preferences</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">NOTIFICATIONS</h3>
          {renderSettingItem(
            'Enable Notifications',
            'Show desktop notifications',
            renderToggle(enableNotifications, () => setEnableNotifications(!enableNotifications))
          )}
          {renderSettingItem(
            'Enable Sounds',
            'Play sound with notifications',
            renderToggle(enableSounds, () => setEnableSounds(!enableSounds))
          )}
          {renderSettingItem(
            'Notify on Complete',
            'Alert when download completes',
            renderToggle(notifyOnComplete, () => setNotifyOnComplete(!notifyOnComplete))
          )}
          {renderSettingItem(
            'Notify on Error',
            'Alert when error occurs',
            renderToggle(notifyOnError, () => setNotifyOnError(!notifyOnError))
          )}
        </div>
      </>
    );
  }

  function renderSystemSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">System Integration</h1>
          <p className="settings-category-subtitle">System-level settings and integration</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">UPDATES</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">Check for Updates</div>
              <p className="setting-description">Look for new versions</p>
            </div>
            <div className="setting-control">
              <Button variant="secondary" onClick={handleCheckForUpdates}>
                Check Now
              </Button>
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">MAINTENANCE</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">Clear Cache</div>
              <p className="setting-description">Remove temporary files and cached data</p>
            </div>
            <div className="setting-control">
              <Button
                variant="secondary"
                icon={<Icon name="trash" size={16} />}
                onClick={handleClearCache}
                loading={clearingCache}
                disabled={clearingCache}
              >
                Clear
              </Button>
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <div className="settings-group">
          <h3 className="settings-group-title">BACKUP</h3>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">Export Settings</div>
              <p className="setting-description">Save your configuration</p>
            </div>
            <div className="setting-control">
              <Button variant="secondary" onClick={handleExportSettings}>
                Export
              </Button>
            </div>
          </div>
          <div className="setting-item">
            <div className="setting-info">
              <div className="setting-label">Import Settings</div>
              <p className="setting-description">Restore saved configuration</p>
            </div>
            <div className="setting-control">
              <Button variant="secondary" onClick={handleImportSettings}>
                Import
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  function renderHotkeySettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">Keyboard Shortcuts</h1>
          <p className="settings-category-subtitle">Customize keyboard hotkeys</p>
        </div>

        <div className="settings-group">
          <h3 className="settings-group-title">HOTKEYS</h3>
          <HotkeySettings
            hotkeys={hotkeys}
            onHotkeyChange={handleHotkeyChange}
            onResetHotkeys={handleResetHotkeys}
          />
        </div>
      </>
    );
  }

  function renderAboutSettings() {
    return (
      <>
        <div className="settings-category-header">
          <h1 className="settings-category-title">About TorrentHunt</h1>
          <p className="settings-category-subtitle">Application information and statistics</p>
        </div>

        <div className="about-section">
          <div className="about-app">
            <div className="about-icon">🔍</div>
            <div className="about-info-text">
              <h2 className="about-app-name">TorrentHunt</h2>
              <p className="about-version">Version 1.0.0</p>
              <p className="about-description">
                A desktop torrent client focused on legal open-source software distribution.
              </p>
            </div>
          </div>

          <div className="settings-divider" />

          <div className="settings-group">
            <h3 className="settings-group-title">STATISTICS</h3>
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
