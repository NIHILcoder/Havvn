/**
 * Settings Page
 * 
 * Application configuration.
 */

import React, { useState, useEffect } from 'react';
import { AppSettings } from '../../shared/types';
import { Button, Icon, Alert } from '../components';
import './SettingsPage.css';

type Theme = 'light' | 'dark' | 'system';

const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Form state
  const [defaultDownloadDir, setDefaultDownloadDir] = useState('');
  const [maxDownKbps, setMaxDownKbps] = useState(0);
  const [maxUpKbps, setMaxUpKbps] = useState(0);
  const [maxActiveDownloads, setMaxActiveDownloads] = useState(3);
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    loadSettings();
    // Load theme from localStorage
    const savedTheme = localStorage.getItem('theme') as Theme || 'system';
    setTheme(savedTheme);
    applyTheme(savedTheme);
  }, []);

  // Auto-dismiss messages
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Track changes
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
    } catch (error) {
      console.error('Failed to load settings:', error);
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  };

  const handleBrowseDirectory = async () => {
    try {
      const dir = await window.api.selectDirectory();
      if (dir) {
        setDefaultDownloadDir(dir);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const updated = await window.api.updateSettings({
        defaultDownloadDir,
        maxDownKbps,
        maxUpKbps,
        maxActiveDownloads,
      });
      setSettings(updated);
      setMessage({ type: 'success', text: 'Settings saved successfully' });
      setHasChanges(false);
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
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
    }
  };

  const handleClearCache = async () => {
    const confirmed = window.confirm(
      'Очистить кеш приложения?\n\n' +
      'Это удалит временные файлы и может помочь решить проблемы с производительностью или ошибками кеширования.\n\n' +
      'Приложение продолжит работу, но может потребоваться повторная загрузка некоторых данных.'
    );
    
    if (!confirmed) return;
    
    setClearingCache(true);
    setMessage(null);
    
    try {
      await window.api.clearCache();
      setMessage({ 
        type: 'success', 
        text: 'Кеш успешно очищен. Рекомендуется перезапустить приложение для полного применения изменений.' 
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Не удалось очистить кеш: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      });
    } finally {
      setClearingCache(false);
    }
  };

  if (loading) {
    return (
      <div className="page-loading">
        <span className="spinner spinner-lg" />
        <p>Loading settings...</p>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <div className="page-actions">
          {hasChanges && (
            <Button variant="ghost" onClick={handleReset}>
              Reset
            </Button>
          )}
          <Button 
            variant="primary"
            icon={<Icon name="check" size={16} />}
            onClick={handleSave}
            loading={saving}
            disabled={!hasChanges || saving}
          >
            Save Changes
          </Button>
        </div>
      </div>

      <div className="page-content">
        {/* Messages */}
        {message && (
          <Alert 
            variant={message.type} 
            onClose={() => setMessage(null)}
            className="message-alert"
          >
            {message.text}
          </Alert>
        )}

        <div className="settings-sections">
          {/* Appearance Section */}
          <section className="settings-section">
            <h2 className="settings-section-title">
              <Icon name="monitor" size={20} />
              Appearance
            </h2>
            <div className="settings-card">
              <div className="setting-item">
                <div className="setting-info">
                  <label className="setting-label">Theme</label>
                  <p className="setting-description">
                    Choose your preferred color scheme or follow system settings.
                  </p>
                </div>
                <div className="setting-control">
                  <div className="theme-selector">
                    <button
                      className={`theme-option ${theme === 'light' ? 'theme-option-active' : ''}`}
                      onClick={() => handleThemeChange('light')}
                    >
                      <Icon name="sun" size={20} />
                      <span>Light</span>
                    </button>
                    <button
                      className={`theme-option ${theme === 'dark' ? 'theme-option-active' : ''}`}
                      onClick={() => handleThemeChange('dark')}
                    >
                      <Icon name="moon" size={20} />
                      <span>Dark</span>
                    </button>
                    <button
                      className={`theme-option ${theme === 'system' ? 'theme-option-active' : ''}`}
                      onClick={() => handleThemeChange('system')}
                    >
                      <Icon name="monitor" size={20} />
                      <span>System</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Downloads Section */}
          <section className="settings-section">
            <h2 className="settings-section-title">
              <Icon name="download" size={20} />
              Downloads
            </h2>
            <div className="settings-card">
              <div className="setting-item">
                <div className="setting-info">
                  <label className="setting-label">Default Download Directory</label>
                  <p className="setting-description">
                    New downloads will be saved here unless you specify a different location.
                  </p>
                </div>
                <div className="setting-control directory-input">
                  <input
                    type="text"
                    className="input"
                    value={defaultDownloadDir}
                    onChange={(e) => setDefaultDownloadDir(e.target.value)}
                  />
                  <Button 
                    icon={<Icon name="folder" size={16} />}
                    onClick={handleBrowseDirectory}
                  >
                    Browse
                  </Button>
                </div>
              </div>

              <div className="setting-divider" />

              <div className="setting-item">
                <div className="setting-info">
                  <label className="setting-label">Max Active Downloads</label>
                  <p className="setting-description">
                    Maximum number of downloads that can run simultaneously.
                  </p>
                </div>
                <div className="setting-control">
                  <input
                    type="number"
                    className="input input-number"
                    min="1"
                    max="10"
                    value={maxActiveDownloads}
                    onChange={(e) => setMaxActiveDownloads(parseInt(e.target.value) || 1)}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Speed Limits Section */}
          <section className="settings-section">
            <h2 className="settings-section-title">
              <Icon name="activity" size={20} />
              Speed Limits
            </h2>
            <div className="settings-card">
              <div className="setting-item">
                <div className="setting-info">
                  <label className="setting-label">Max Download Speed</label>
                  <p className="setting-description">
                    Limit download speed. Set to 0 for unlimited.
                  </p>
                </div>
                <div className="setting-control speed-input">
                  <input
                    type="number"
                    className="input input-number"
                    min="0"
                    value={maxDownKbps}
                    onChange={(e) => setMaxDownKbps(parseInt(e.target.value) || 0)}
                  />
                  <span className="speed-unit">KB/s</span>
                </div>
              </div>

              <div className="setting-divider" />

              <div className="setting-item">
                <div className="setting-info">
                  <label className="setting-label">Max Upload Speed</label>
                  <p className="setting-description">
                    Limit upload speed. Set to 0 for unlimited.
                  </p>
                </div>
                <div className="setting-control speed-input">
                  <input
                    type="number"
                    className="input input-number"
                    min="0"
                    value={maxUpKbps}
                    onChange={(e) => setMaxUpKbps(parseInt(e.target.value) || 0)}
                  />
                  <span className="speed-unit">KB/s</span>
                </div>
              </div>

              <div className="settings-notice">
                <Icon name="info" size={16} />
                <span>
                  Speed limiting is best-effort due to WebTorrent limitations. 
                  Actual speeds may vary.
                </span>
              </div>
            </div>
          </section>

          {/* About Section */}
          <section className="settings-section">
            <h2 className="settings-section-title">
              <Icon name="info" size={20} />
              About
            </h2>
            <div className="settings-card">
              <div className="about-info">
                <div className="about-logo">🔍</div>
                <div className="about-text">
                  <h3>TorrentHunt</h3>
                  <p>Version 1.0.0</p>
                  <p className="about-tagline">
                    A desktop torrent client focused on legal open-source software.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Maintenance Section */}
            <section className="settings-section">
            <h2 className="settings-section-title">
              <Icon name="settings" size={20} />
              Обслуживание
            </h2>
            <div className="settings-card">
              <div className="setting-item">
                <div className="setting-info">
                  <label className="setting-label">Очистка кеша</label>
                  <p className="setting-description">
                    Удаляет временные файлы, кеш GPU и другие накопленные данные.
                    Используйте при возникновении проблем с производительностью,
                    ошибками отказа в доступе к кешу или зависаниями приложения.
                  </p>
                </div>
                <div className="setting-control">
                  <Button
                    variant="secondary"
                    icon={<Icon name="trash" size={16} />}
                    onClick={handleClearCache}
                    loading={clearingCache}
                    disabled={clearingCache}
                  >
                    Очистить кеш
                  </Button>
                </div>
              </div>

              <div className="settings-notice">
                <Icon name="info" size={16} />
                <span>
                  Очистка кеша безопасна и не удалит ваши загрузки или настройки.
                  После очистки рекомендуется перезапустить приложение.
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
};

export default SettingsPage;
