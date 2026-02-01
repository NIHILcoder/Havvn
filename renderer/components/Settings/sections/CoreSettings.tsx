/**
 * CoreSettings Section
 * Main VirusHunt settings: enabled, auto-scan, scan mode, silent mode, sensitivity
 */

import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';

export const CoreSettings: React.FC = () => {
  const { control, watch } = useFormContext<VirusHuntSettings>();
  
  const sensitivity = watch('sensitivity');

  const getSensitivityLabel = (value: number): string => {
    if (value <= 2) return 'Very Low - Minimal detection';
    if (value <= 4) return 'Low - Basic protection';
    if (value <= 6) return 'Medium - Balanced';
    if (value <= 8) return 'High - Increased security';
    return 'Very High - Maximum protection';
  };

  const getSensitivityColor = (value: number): string => {
    if (value <= 3) return '#10b981'; // green
    if (value <= 6) return '#f59e0b'; // yellow
    return '#ef4444'; // red
  };

  return (
    <div className="settings-section">
      <h3 className="section-title">Core Protection</h3>
      <p className="section-description">
        Configure the main VirusHunt protection settings. These control how the system scans and analyzes files for threats.
      </p>

      {/* Enabled Toggle */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">VirusHunt Protection</label>
          <Controller
            name="enabled"
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
          Master switch for VirusHunt protection. When disabled, no scanning will occur.
        </p>
      </div>

      {/* Auto-scan after download */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Auto-scan after download</label>
          <Controller
            name="autoScanAfterDownload"
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
          Automatically scan files immediately after download completes. Recommended for maximum protection.
        </p>
      </div>

      {/* Scan only new files */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Scan only new files</label>
          <Controller
            name="scanOnlyNewFiles"
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
          Skip scanning files that have already been scanned and haven't changed. Improves performance but may miss threats in previously clean files.
        </p>
      </div>

      {/* Silent mode */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Silent mode</label>
          <Controller
            name="silentMode"
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
          Suppress all notifications during scans. Threats will still be logged and can be reviewed later.
        </p>
      </div>

      {/* Sensitivity slider */}
      <div className="form-group">
        <label className="form-label">Detection sensitivity</label>
        <div className="range-slider">
          <div className="slider-value" style={{ backgroundColor: getSensitivityColor(sensitivity) }}>
            Level {sensitivity} - {getSensitivityLabel(sensitivity)}
          </div>
          <Controller
            name="sensitivity"
            control={control}
            render={({ field }) => (
              <Slider
                min={1}
                max={10}
                step={1}
                value={field.value}
                onChange={field.onChange}
                marks={{
                  1: 'Min',
                  5: 'Default',
                  10: 'Max',
                }}
                railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
                trackStyle={{ backgroundColor: getSensitivityColor(sensitivity), height: 6 }}
                handleStyle={{
                  backgroundColor: getSensitivityColor(sensitivity),
                  border: 'none',
                  width: 20,
                  height: 20,
                  marginTop: -7,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                }}
                dotStyle={{ display: 'none' }}
              />
            )}
          />
        </div>
        <p className="form-description">
          Controls how aggressively VirusHunt detects potential threats. Higher sensitivity may result in more false positives.
          <br />
          <strong>Recommended:</strong> Level 5 for balanced protection.
        </p>
      </div>
    </div>
  );
};
