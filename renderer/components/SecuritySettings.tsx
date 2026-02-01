/**
 * Security Settings Component
 * 
 * VirusHunt security configuration panel for the Settings page.
 */

import React, { useState, useEffect } from 'react';
import { Toggle, Button, Icon, Input } from './index';
import { useVirusHunt } from '../contexts/VirusHuntContext';
import './SecuritySettings.css';

interface SecuritySettingsState {
  enabled: boolean;
  autoScanOnComplete: boolean;
  scanDepth: 'quick' | 'normal' | 'deep';
  maxFileSize: number; // MB
  skipArchives: boolean;
  skipExecutables: boolean;
  quarantineEnabled: boolean;
  quarantinePath: string;
  deleteOnThreat: boolean;
  notifyOnThreat: boolean;
  notifyOnSafe: boolean;
  soundAlerts: boolean;
}

export const SecuritySettings: React.FC = () => {
  const { autoScanEnabled, setAutoScanEnabled } = useVirusHunt();
  
  const [settings, setSettings] = useState<SecuritySettingsState>({
    enabled: false,
    autoScanOnComplete: false,
    scanDepth: 'normal',
    maxFileSize: 500,
    skipArchives: false,
    skipExecutables: false,
    quarantineEnabled: false,
    quarantinePath: '',
    deleteOnThreat: false,
    notifyOnThreat: true,
    notifyOnSafe: false,
    soundAlerts: true,
  });

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [dbVersions, setDbVersions] = useState<any>(null);

  // Load settings
  useEffect(() => {
    loadSettings();
    loadDbVersions();
  }, []);

  const loadSettings = async () => {
    try {
      const config = await window.api.virusHunt.getConfig();
      const enabled = await window.api.virusHunt.isEnabled();
      const quarantinePath = await window.api.virusHunt.getQuarantinePath();

      setSettings({
        enabled,
        autoScanOnComplete: autoScanEnabled,
        scanDepth: config.scanDepth || 'normal',
        maxFileSize: config.maxFileSize || 500,
        skipArchives: config.skipArchives || false,
        skipExecutables: config.skipExecutables || false,
        quarantineEnabled: config.quarantineEnabled || false,
        quarantinePath: quarantinePath || '',
        deleteOnThreat: config.deleteOnThreat || false,
        notifyOnThreat: config.notifyOnThreat ?? true,
        notifyOnSafe: config.notifyOnSafe || false,
        soundAlerts: config.soundAlerts ?? true,
      });
    } catch (error) {
      console.error('Failed to load security settings:', error);
      showMessage('error', 'Failed to load settings');
    }
  };

  const loadDbVersions = async () => {
    try {
      const versions = await window.api.virusHunt.getDatabaseVersions();
      setDbVersions(versions);
    } catch (error) {
      console.error('Failed to load database versions:', error);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);

    try {
      // Update VirusHunt config
      await window.api.virusHunt.updateConfig({
        scanDepth: settings.scanDepth,
        maxFileSize: settings.maxFileSize,
        skipArchives: settings.skipArchives,
        skipExecutables: settings.skipExecutables,
        quarantineEnabled: settings.quarantineEnabled,
        deleteOnThreat: settings.deleteOnThreat,
        notifyOnThreat: settings.notifyOnThreat,
        notifyOnSafe: settings.notifyOnSafe,
        soundAlerts: settings.soundAlerts,
      });

      // Update enabled state
      await window.api.virusHunt.setEnabled(settings.enabled);

      // Update quarantine path
      if (settings.quarantinePath) {
        await window.api.virusHunt.setQuarantinePath(settings.quarantinePath);
      }

      // Update auto-scan via context
      setAutoScanEnabled(settings.autoScanOnComplete);

      showMessage('success', 'Security settings saved successfully');
    } catch (error) {
      console.error('Failed to save security settings:', error);
      showMessage('error', 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = async () => {
    if (!confirm('Reset all security settings to defaults?')) return;

    try {
      await window.api.virusHunt.resetConfig();
      await loadSettings();
      showMessage('success', 'Settings reset to defaults');
    } catch (error) {
      console.error('Failed to reset settings:', error);
      showMessage('error', 'Failed to reset settings');
    }
  };

  const selectQuarantinePath = async () => {
    try {
      const path = await window.api.selectDirectory();
      if (path) {
        setSettings(prev => ({ ...prev, quarantinePath: path }));
      }
    } catch (error) {
      console.error('Failed to select quarantine path:', error);
    }
  };

  const exportDatabase = async (type: 'hashes' | 'torrents' | 'releaseGroups') => {
    try {
      const defaultName = `virushunt-${type}-${new Date().toISOString().split('T')[0]}.json`;
      const savePath = await window.api.selectSaveTorrentPath(defaultName);
      
      if (savePath) {
        await window.api.virusHunt.exportDatabase(type, savePath);
        showMessage('success', `${type} database exported successfully`);
      }
    } catch (error) {
      console.error('Failed to export database:', error);
      showMessage('error', 'Export failed');
    }
  };

  const importDatabase = async (type: 'hashes' | 'torrents' | 'releaseGroups') => {
    try {
      const result = await window.api.dialog.showOpenDialog({
        title: `Import ${type} Database`,
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile'],
      });

      if (!result.canceled && result.filePaths[0]) {
        await window.api.virusHunt.importDatabase(type, result.filePaths[0]);
        await loadDbVersions();
        showMessage('success', `${type} database imported successfully`);
      }
    } catch (error) {
      console.error('Failed to import database:', error);
      showMessage('error', 'Import failed');
    }
  };

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  return (
    <div className="security-settings">
      <div className="settings-section">
        <h3 className="settings-section-title">General</h3>
        
        <div className="settings-item">
          <div className="settings-item-info">
            <label>Enable VirusHunt</label>
            <p className="settings-description">
              Activate security scanning for all downloads
            </p>
          </div>
          <Toggle
            checked={settings.enabled}
            onChange={(checked) => setSettings(prev => ({ ...prev, enabled: checked }))}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Auto-scan Completed Downloads</label>
            <p className="settings-description">
              Automatically scan torrents when they finish downloading
            </p>
          </div>
          <Toggle
            checked={settings.autoScanOnComplete}
            onChange={(checked) => setSettings(prev => ({ ...prev, autoScanOnComplete: checked }))}
            disabled={!settings.enabled}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Scan Configuration</h3>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Scan Depth</label>
            <p className="settings-description">
              Quick: Fast scan | Normal: Balanced | Deep: Thorough analysis
            </p>
          </div>
          <select
            className="settings-select"
            value={settings.scanDepth}
            onChange={(e) => setSettings(prev => ({ 
              ...prev, 
              scanDepth: e.target.value as 'quick' | 'normal' | 'deep' 
            }))}
            disabled={!settings.enabled}
          >
            <option value="quick">Quick</option>
            <option value="normal">Normal</option>
            <option value="deep">Deep</option>
          </select>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Max File Size (MB)</label>
            <p className="settings-description">
              Skip files larger than this size (0 = no limit)
            </p>
          </div>
          <Input
            type="number"
            value={settings.maxFileSize}
            onChange={(e) => setSettings(prev => ({ 
              ...prev, 
              maxFileSize: parseInt(e.target.value) || 0 
            }))}
            min={0}
            disabled={!settings.enabled}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Skip Archives</label>
            <p className="settings-description">
              Don't scan ZIP, RAR, 7Z files
            </p>
          </div>
          <Toggle
            checked={settings.skipArchives}
            onChange={(checked) => setSettings(prev => ({ ...prev, skipArchives: checked }))}
            disabled={!settings.enabled}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Skip Executables</label>
            <p className="settings-description">
              Don't scan EXE, DLL, SO files
            </p>
          </div>
          <Toggle
            checked={settings.skipExecutables}
            onChange={(checked) => setSettings(prev => ({ ...prev, skipExecutables: checked }))}
            disabled={!settings.enabled}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Quarantine</h3>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Enable Quarantine</label>
            <p className="settings-description">
              Move detected threats to quarantine folder
            </p>
          </div>
          <Toggle
            checked={settings.quarantineEnabled}
            onChange={(checked) => setSettings(prev => ({ ...prev, quarantineEnabled: checked }))}
            disabled={!settings.enabled}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Quarantine Path</label>
            <p className="settings-description">
              Location to store quarantined files
            </p>
          </div>
          <div className="settings-path-input">
            <Input
              value={settings.quarantinePath}
              onChange={(e) => setSettings(prev => ({ ...prev, quarantinePath: e.target.value }))}
              placeholder="Select quarantine folder"
              disabled={!settings.enabled || !settings.quarantineEnabled}
            />
            <Button
              variant="secondary"
              onClick={selectQuarantinePath}
              disabled={!settings.enabled || !settings.quarantineEnabled}
            >
              <Icon name="folder" size={16} />
            </Button>
          </div>
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Auto-Delete Threats</label>
            <p className="settings-description">
              Automatically delete dangerous files instead of quarantine
            </p>
          </div>
          <Toggle
            checked={settings.deleteOnThreat}
            onChange={(checked) => setSettings(prev => ({ ...prev, deleteOnThreat: checked }))}
            disabled={!settings.enabled}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Notifications</h3>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Notify on Threats</label>
            <p className="settings-description">
              Show notification when threats are detected
            </p>
          </div>
          <Toggle
            checked={settings.notifyOnThreat}
            onChange={(checked) => setSettings(prev => ({ ...prev, notifyOnThreat: checked }))}
            disabled={!settings.enabled}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Notify on Safe Scan</label>
            <p className="settings-description">
              Show notification when scan finds no threats
            </p>
          </div>
          <Toggle
            checked={settings.notifyOnSafe}
            onChange={(checked) => setSettings(prev => ({ ...prev, notifyOnSafe: checked }))}
            disabled={!settings.enabled}
          />
        </div>

        <div className="settings-item">
          <div className="settings-item-info">
            <label>Sound Alerts</label>
            <p className="settings-description">
              Play sound when threats are detected
            </p>
          </div>
          <Toggle
            checked={settings.soundAlerts}
            onChange={(checked) => setSettings(prev => ({ ...prev, soundAlerts: checked }))}
            disabled={!settings.enabled}
          />
        </div>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Database Management</h3>

        {dbVersions && (
          <div className="database-info">
            <div className="db-version-item">
              <span>File Hashes Database:</span>
              <span>v{dbVersions.hashes?.version || '1.0'} ({dbVersions.hashes?.entriesCount || 0} entries)</span>
            </div>
            <div className="db-version-item">
              <span>Torrent Reputation:</span>
              <span>v{dbVersions.torrents?.version || '1.0'} ({dbVersions.torrents?.entriesCount || 0} entries)</span>
            </div>
            <div className="db-version-item">
              <span>Release Groups:</span>
              <span>v{dbVersions.releaseGroups?.version || '1.0'} ({dbVersions.releaseGroups?.entriesCount || 0} entries)</span>
            </div>
          </div>
        )}

        <div className="database-actions">
          <div className="db-action-group">
            <label>File Hashes</label>
            <div className="button-row">
              <Button variant="secondary" size="sm" onClick={() => exportDatabase('hashes')}>
                Export
              </Button>
              <Button variant="secondary" size="sm" onClick={() => importDatabase('hashes')}>
                Import
              </Button>
            </div>
          </div>

          <div className="db-action-group">
            <label>Torrent Reputation</label>
            <div className="button-row">
              <Button variant="secondary" size="sm" onClick={() => exportDatabase('torrents')}>
                Export
              </Button>
              <Button variant="secondary" size="sm" onClick={() => importDatabase('torrents')}>
                Import
              </Button>
            </div>
          </div>

          <div className="db-action-group">
            <label>Release Groups</label>
            <div className="button-row">
              <Button variant="secondary" size="sm" onClick={() => exportDatabase('releaseGroups')}>
                Export
              </Button>
              <Button variant="secondary" size="sm" onClick={() => importDatabase('releaseGroups')}>
                Import
              </Button>
            </div>
          </div>
        </div>
      </div>

      {message && (
        <div className={`settings-message ${message.type}`}>
          <Icon name={message.type === 'success' ? 'check-circle' : 'alert-circle'} size={16} />
          <span>{message.text}</span>
        </div>
      )}

      <div className="settings-actions">
        <Button variant="secondary" onClick={resetToDefaults} disabled={saving}>
          Reset to Defaults
        </Button>
        <Button variant="primary" onClick={saveSettings} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
};
