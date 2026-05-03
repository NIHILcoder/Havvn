/**
 * Privacy Settings Component
 *
 * Advanced privacy controls for TorrentHunt
 */

import React, { useState, useEffect } from 'react';
import { Icon } from './Icon';
import { Toggle } from './Toggle';
import { Button } from './Button';
import { Alert } from './Alert';
import './PrivacySettings.css';

interface PrivacyConfig {
  anonymousMode: boolean;
  encryptStorage: boolean;
  disableLogs: boolean;
  vpnCheck: boolean;
  clearDataOnExit: boolean;
  ephemeralPeerId: boolean;
  sanitizeLogs: boolean;
}

interface VPNDetectionResult {
  isVPNActive: boolean;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  indicators: {
    vpnInterface: boolean;
    ipMismatch: boolean;
    vpnDNS: boolean;
    vpnRoutes: boolean;
  };
  details: {
    detectedInterfaces: string[];
    publicIP?: string;
    localIP?: string;
    vpnProvider?: string;
  };
}

export const PrivacySettings: React.FC = () => {
  const [config, setConfig] = useState<PrivacyConfig>({
    anonymousMode: true,
    encryptStorage: true,
    disableLogs: false,
    vpnCheck: true,
    clearDataOnExit: false,
    ephemeralPeerId: true,
    sanitizeLogs: true,
  });

  const [vpnStatus, setVpnStatus] = useState<'unknown' | 'connected' | 'disconnected'>('unknown');
  const [vpnDetails, setVpnDetails] = useState<VPNDetectionResult | null>(null);
  const [isCheckingVPN, setIsCheckingVPN] = useState(false);
  const [encryptionAvailable] = useState(true);

  useEffect(() => {
    void loadPrivacySettings();
    void checkVPNStatus();
  }, []);

  const loadPrivacySettings = async () => {
    // Load from store
    // const settings = await window.api.getPrivacySettings();
    // setConfig(settings);
  };

  const checkVPNStatus = async () => {
    setIsCheckingVPN(true);
    try {
      const result = await window.api.getPrivacyConfig() as unknown as VPNDetectionResult;
      setVpnDetails(result);
      setVpnStatus(result.isVPNActive ? 'connected' : 'disconnected');
    } catch (error) {
      console.error('Failed to check VPN status:', error);
      setVpnStatus('unknown');
    } finally {
      setIsCheckingVPN(false);
    }
  };

  const handleChange = async (key: keyof PrivacyConfig, value: boolean) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);

    // Save to backend
    // await window.api.updatePrivacySettings(newConfig);
  };

  const handleClearAllData = async () => {
    const confirmed = confirm(
      '⚠️ This will permanently delete all your data including:\n\n' +
      '• All downloads and torrents\n' +
      '• Reputation and transactions\n' +
      '• Categories and settings\n' +
      '• All logs and temporary files\n\n' +
      'This action CANNOT be undone!\n\n' +
      'Are you absolutely sure?'
    );

    if (!confirmed) return;

    // Second confirmation
    const doubleConfirmed = confirm(
      '⚠️ FINAL WARNING!\n\n' +
      'You are about to delete ALL DATA.\n' +
      'Type YES in your mind and click OK to proceed.'
    );

    if (!doubleConfirmed) return;

    try {
      await window.api.clearAllData();
      alert('✅ All data cleared successfully!\n\nThe application will reload.');

      // Reload the page to reflect changes
      window.location.reload();
    } catch (error) {
      console.error('Failed to clear data:', error);
      alert('❌ Failed to clear data. Check console for details.');
    }
  };

  return (
    <div className="privacy-settings">
      {/* Header */}
      <div className="settings-category-header">
        <h1 className="settings-category-title">🔒 Privacy & Anonymity</h1>
        <p className="settings-category-subtitle">
          Configure advanced privacy features to protect your anonymity
        </p>
      </div>

      {/* VPN Status */}
      {vpnStatus === 'connected' && vpnDetails && (
        <Alert variant="success">
          <strong>✅ VPN Detected!</strong>
          <p>
            {vpnDetails.details.vpnProvider
              ? `Connected via ${vpnDetails.details.vpnProvider}`
              : 'VPN connection detected'}
            {' '}(Confidence: {vpnDetails.confidence})
          </p>
          {vpnDetails.details.detectedInterfaces.length > 0 && (
            <p style={{ fontSize: '0.85em', opacity: 0.8 }}>
              Interfaces: {vpnDetails.details.detectedInterfaces.join(', ')}
            </p>
          )}
        </Alert>
      )}

      {vpnStatus === 'disconnected' && vpnDetails && (
        <Alert variant="warning">
          <strong>⚠️ VPN Not Detected!</strong>
          <p>Your real IP address may be visible to peers. Consider using a VPN for better privacy.</p>
          {vpnDetails.details.publicIP && (
            <p style={{ fontSize: '0.85em', opacity: 0.8 }}>
              Your public IP: {vpnDetails.details.publicIP}
            </p>
          )}
          <Button
            variant="secondary"
            onClick={checkVPNStatus}
            disabled={isCheckingVPN}
            style={{ marginTop: '8px' }}
          >
            <Icon name="refresh-cw" size={14} />
            {isCheckingVPN ? 'Checking...' : 'Re-check VPN'}
          </Button>
        </Alert>
      )}

      {vpnStatus === 'unknown' && (
        <Alert variant="info">
          <strong>ℹ️ VPN Status Unknown</strong>
          <p>Unable to determine VPN status. Click to check manually.</p>
          <Button
            variant="secondary"
            onClick={checkVPNStatus}
            disabled={isCheckingVPN}
            style={{ marginTop: '8px' }}
          >
            <Icon name="refresh-cw" size={14} />
            {isCheckingVPN ? 'Checking...' : 'Check VPN Status'}
          </Button>
        </Alert>
      )}

      {/* Encryption Status */}
      {!encryptionAvailable && (
        <Alert variant="info">
          <strong>ℹ️ Encryption Unavailable</strong>
          <p>Your system doesn't support secure encryption. Data will be obfuscated but not fully encrypted.</p>
        </Alert>
      )}

      {/* Anonymous Mode */}
      <div className="settings-group">
        <h3 className="settings-group-title">ANONYMITY</h3>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="eye-off" size={16} />
              Anonymous Mode
            </label>
            <p className="setting-description">
              Use ephemeral User ID that rotates daily. Prevents long-term tracking.
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.anonymousMode}
              onChange={(checked) => handleChange('anonymousMode', checked)}
            />
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="refresh-cw" size={16} />
              Ephemeral Peer ID
            </label>
            <p className="setting-description">
              Generate new Peer ID every 24 hours for DHT network anonymity.
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.ephemeralPeerId}
              onChange={(checked) => handleChange('ephemeralPeerId', checked)}
            />
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="shield" size={16} />
              VPN Detection
            </label>
            <p className="setting-description">
              Show warning if VPN is not detected on startup.
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.vpnCheck}
              onChange={(checked) => handleChange('vpnCheck', checked)}
            />
          </div>
        </div>
      </div>

      {/* Data Protection */}
      <div className="settings-group">
        <h3 className="settings-group-title">DATA PROTECTION</h3>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="lock" size={16} />
              Encrypt Storage
            </label>
            <p className="setting-description">
              Encrypt sensitive data using OS-level encryption (Keychain/DPAPI).
              {encryptionAvailable ? ' ✅ Available' : ' ⚠️ Not available on this system'}
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.encryptStorage}
              onChange={(checked) => handleChange('encryptStorage', checked)}
              disabled={!encryptionAvailable}
            />
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="trash" size={16} />
              Clear Data on Exit
            </label>
            <p className="setting-description">
              Automatically delete logs and temporary data when closing the app.
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.clearDataOnExit}
              onChange={(checked) => handleChange('clearDataOnExit', checked)}
            />
          </div>
        </div>
      </div>

      {/* Logging */}
      <div className="settings-group">
        <h3 className="settings-group-title">LOGGING</h3>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="file-text" size={16} />
              Sanitize Logs
            </label>
            <p className="setting-description">
              Remove or hash sensitive data (IPs, IDs) in log files.
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.sanitizeLogs}
              onChange={(checked) => handleChange('sanitizeLogs', checked)}
            />
          </div>
        </div>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="x-circle" size={16} />
              Disable Logging
            </label>
            <p className="setting-description">
              Completely disable file logging. ⚠️ Makes debugging difficult.
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              checked={config.disableLogs}
              onChange={(checked) => handleChange('disableLogs', checked)}
            />
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="settings-group danger-zone">
        <h3 className="settings-group-title">⚠️ DANGER ZONE</h3>

        <div className="setting-item">
          <div className="setting-info">
            <label className="setting-label">
              <Icon name="alert-triangle" size={16} />
              Clear All Data
            </label>
            <p className="setting-description">
              Permanently delete all data including reputation, downloads, and settings.
              This action cannot be undone!
            </p>
          </div>
          <div className="setting-control">
            <Button
              variant="danger"
              onClick={handleClearAllData}
            >
              <Icon name="trash" size={16} />
              Clear All Data
            </Button>
          </div>
        </div>
      </div>

      {/* Privacy Tips */}
      <div className="privacy-tips">
        <h3>💡 Privacy Tips</h3>
        <ul>
          <li><strong>Use VPN:</strong> Always use a trustworthy VPN to hide your real IP address</li>
          <li><strong>Bind to VPN:</strong> Configure network binding to VPN interface to prevent IP leaks</li>
          <li><strong>Disable WebRTC:</strong> If using magnet links in browser, disable WebRTC to prevent leaks</li>
          <li><strong>Use Private Trackers:</strong> Enable "Private torrent" option when creating torrents</li>
          <li><strong>Check Regularly:</strong> Use IPLeak.net to verify your IP is hidden</li>
        </ul>
      </div>

      {/* Privacy Score */}
      <div className="privacy-score">
        <h3>Privacy Score</h3>
        <div className="score-bar">
          <div
            className="score-fill"
            style={{
              width: `${calculatePrivacyScore(config, vpnStatus)}%`,
              backgroundColor: getScoreColor(calculatePrivacyScore(config, vpnStatus))
            }}
          />
        </div>
        <div className="score-label">
          {calculatePrivacyScore(config, vpnStatus)}/100 - {getScoreLabel(calculatePrivacyScore(config, vpnStatus))}
        </div>
      </div>
    </div>
  );
};

function calculatePrivacyScore(config: PrivacyConfig, vpnStatus: string): number {
  let score = 0;

  if (config.anonymousMode) score += 20;
  if (config.ephemeralPeerId) score += 20;
  if (config.encryptStorage) score += 15;
  if (config.sanitizeLogs) score += 10;
  if (config.clearDataOnExit) score += 10;
  if (vpnStatus === 'connected') score += 25;

  return Math.min(100, score);
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#22c55e'; // Green
  if (score >= 60) return '#f59e0b'; // Orange
  return '#ef4444'; // Red
}

function getScoreLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  return 'Poor';
}
