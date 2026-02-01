/**
 * DatabaseSettings Section
 * Database path, auto-update settings, and statistics
 */

import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';
import { Button } from '../../Button';
import { FiRefreshCw, FiFolder } from 'react-icons/fi';

export const DatabaseSettings: React.FC = () => {
  const { control, register, watch } = useFormContext<VirusHuntSettings>();
  
  const stats = watch('databases.statistics');
  const lastUpdate = watch('databases.lastUpdate');
  const autoUpdate = watch('databases.autoUpdate');

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="settings-section">
      <h3 className="section-title">Threat Databases</h3>
      <p className="section-description">
        Configure threat signature databases and update settings. Regular updates ensure protection against the latest threats.
      </p>

      {/* Database path */}
      <div className="form-group">
        <label className="form-label">Database path</label>
        <div className="input-with-button">
          <input
            type="text"
            className="form-control"
            placeholder="Default: userData/virusHunt/databases"
            {...register('databases.path')}
          />
          <Button variant="secondary" icon={<FiFolder />}>
            Browse
          </Button>
        </div>
        <p className="form-description">
          Location where threat signature databases are stored.
        </p>
      </div>

      {/* Auto-update */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Automatic updates</label>
          <Controller
            name="databases.autoUpdate"
            control={control}
            render={({ field }) => (
              <Toggle
                checked={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>
        <p className="form-description">
          Automatically download and install database updates in the background.
        </p>
      </div>

      {/* Update frequency */}
      {autoUpdate && (
        <div className="form-group">
          <label className="form-label">Update frequency</label>
          <select
            className="form-control"
            {...register('databases.updateFrequency')}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="manual">Manual only</option>
          </select>
          <p className="form-description">
            How often to check for database updates. Daily is recommended for maximum protection.
          </p>
        </div>
      )}

      {/* Last update */}
      <div className="form-group">
        <label className="form-label">Last update</label>
        <div className="update-info">
          <span>{lastUpdate ? formatDate(lastUpdate) : 'Never'}</span>
          <Button variant="primary" icon={<FiRefreshCw />}>
            Update Now
          </Button>
        </div>
      </div>

      {/* Statistics */}
      <div className="form-group">
        <label className="form-label">Database statistics</label>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{formatBytes(stats.totalSize)}</div>
            <div className="stat-label">Database Size</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.whitelistCount.toLocaleString()}</div>
            <div className="stat-label">Whitelist Entries</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.blacklistCount.toLocaleString()}</div>
            <div className="stat-label">Blacklist Entries</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.releaseGroupsCount.toLocaleString()}</div>
            <div className="stat-label">Release Groups</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.patternsCount.toLocaleString()}</div>
            <div className="stat-label">Threat Patterns</div>
          </div>
        </div>
      </div>

      <style>{`
        .input-with-button {
          display: flex;
          gap: 0.5rem;
        }

        .input-with-button .form-control {
          flex: 1;
        }

        .update-info {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 6px;
        }
      `}</style>
    </div>
  );
};
