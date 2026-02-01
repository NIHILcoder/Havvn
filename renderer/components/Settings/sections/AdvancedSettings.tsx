/**
 * AdvancedSettings Section
 */

import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';
import { Button } from '../../Button';
import { FiFolder, FiAlertTriangle } from 'react-icons/fi';

export const AdvancedSettings: React.FC = () => {
  const { control, register, watch } = useFormContext<VirusHuntSettings>();
  
  const debugMode = watch('advanced.debugMode');
  const maxLogSize = watch('advanced.maxLogSize');

  return (
    <div className="settings-section">
      <div className="warning-banner">
        <FiAlertTriangle className="warning-icon" />
        <div>
          <strong>Advanced Settings</strong>
          <p>These settings are for advanced users. Incorrect configuration may affect scanner performance or accuracy.</p>
        </div>
      </div>

      {/* Debug mode */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Debug mode</label>
          <Controller
            name="advanced.debugMode"
            control={control}
            render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
          />
        </div>
        <p className="form-description">
          Enable detailed logging for troubleshooting. May impact performance.
        </p>
      </div>

      {/* Log path */}
      <div className="form-group">
        <label className="form-label">Log file path</label>
        <div className="input-with-button">
          <input
            type="text"
            className="form-control"
            placeholder="Default: userData/virusHunt/logs"
            {...register('advanced.logPath')}
          />
          <Button variant="secondary" icon={<FiFolder />}>
            Browse
          </Button>
        </div>
        <p className="form-description">
          Directory where log files are stored.
        </p>
      </div>

      {/* Log level */}
      <div className="form-group">
        <label className="form-label">Log level</label>
        <select className="form-control" {...register('advanced.logLevel')}>
          <option value="error">Error only</option>
          <option value="warn">Warnings and errors</option>
          <option value="info">Info, warnings, and errors</option>
          <option value="debug">Debug (verbose)</option>
          <option value="trace">Trace (very verbose)</option>
        </select>
        <p className="form-description">
          Amount of detail to include in logs. Higher levels create larger log files.
        </p>
      </div>

      {/* Max log size */}
      <div className="form-group">
        <label className="form-label">Maximum log size: {maxLogSize} MB</label>
        <input
          type="range"
          min="1"
          max="1000"
          step="10"
          className="form-control-range"
          {...register('advanced.maxLogSize', { valueAsNumber: true })}
        />
        <p className="form-description">
          Maximum size for log files before rotation. Older logs are archived.
        </p>
      </div>

      {/* Telemetry */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Enable telemetry</label>
          <Controller
            name="advanced.enableTelemetry"
            control={control}
            render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
          />
        </div>
        <p className="form-description">
          Send anonymous usage statistics to help improve VirusHunt. No personal data is collected.
        </p>
      </div>

      {/* Custom scanner path */}
      <div className="form-group">
        <label className="form-label">Custom scanner executable (optional)</label>
        <div className="input-with-button">
          <input
            type="text"
            className="form-control"
            placeholder="Leave empty to use built-in scanner"
            {...register('advanced.customScannerPath')}
          />
          <Button variant="secondary" icon={<FiFolder />}>
            Browse
          </Button>
        </div>
        <p className="form-description">
          Path to external scanner executable. Leave empty to use the built-in VirusHunt scanner.
        </p>
      </div>

      <style>{`
        .warning-banner {
          display: flex;
          gap: 1rem;
          padding: 1rem;
          background: rgba(245, 158, 11, 0.1);
          border: 1px solid rgba(245, 158, 11, 0.3);
          border-radius: 8px;
          margin-bottom: 2rem;
        }

        .warning-banner .warning-icon {
          width: 24px;
          height: 24px;
          color: #f59e0b;
          flex-shrink: 0;
          margin-top: 2px;
        }

        .warning-banner strong {
          display: block;
          color: #f59e0b;
          font-size: 1rem;
          margin-bottom: 0.25rem;
        }

        .warning-banner p {
          margin: 0;
          color: var(--text-secondary);
          font-size: 0.875rem;
        }

        .input-with-button {
          display: flex;
          gap: 0.5rem;
        }

        .input-with-button .form-control {
          flex: 1;
        }

        .form-control-range {
          width: 100%;
        }
      `}</style>
    </div>
  );
};
