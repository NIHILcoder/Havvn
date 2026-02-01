/**
 * HeuristicsSettings Section
 * Advanced heuristic analysis settings
 */

import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';
import { Disclosure } from '@headlessui/react';
import { FiChevronDown } from 'react-icons/fi';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';

export const HeuristicsSettings: React.FC = () => {
  const { control, register, watch } = useFormContext<VirusHuntSettings>();
  
  const enabled = watch('heuristics.enabled');
  const entropyThreshold = watch('heuristics.entropyThreshold');
  const suspiciousImportsThreshold = watch('heuristics.suspiciousImportsThreshold');
  const riskScoreThreshold = watch('heuristics.riskScoreThreshold');

  return (
    <div className="settings-section">
      <h3 className="section-title">Heuristic Analysis</h3>
      <p className="section-description">
        Heuristic analysis detects unknown threats by analyzing file behavior and characteristics. 
        Configure thresholds and enable specific analysis techniques.
      </p>

      {/* Enable/Disable */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Enable heuristic analysis</label>
          <Controller
            name="heuristics.enabled"
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
          Master switch for heuristic analysis. Disabling this will rely only on signature-based detection.
        </p>
      </div>

      {enabled && (
        <>
          {/* Thresholds */}
          <Disclosure defaultOpen>
            {({ open }) => (
              <>
                <Disclosure.Button className="disclosure-button">
                  <span>Detection Thresholds</span>
                  <FiChevronDown className={`disclosure-icon ${open ? 'open' : ''}`} />
                </Disclosure.Button>
                <Disclosure.Panel className="disclosure-panel">
                  {/* Entropy threshold */}
                  <div className="form-group">
                    <label className="form-label">
                      Entropy threshold: {entropyThreshold.toFixed(2)} (0-8)
                    </label>
                    <Controller
                      name="heuristics.entropyThreshold"
                      control={control}
                      render={({ field }) => (
                        <Slider
                          min={0}
                          max={8}
                          step={0.1}
                          value={field.value}
                          onChange={field.onChange}
                          marks={{ 0: '0', 4: '4', 8: '8' }}
                          railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
                          trackStyle={{ backgroundColor: '#3b82f6', height: 6 }}
                          handleStyle={{
                            backgroundColor: '#3b82f6',
                            border: 'none',
                            width: 18,
                            height: 18,
                            marginTop: -6,
                          }}
                        />
                      )}
                    />
                    <p className="form-description">
                      Files with entropy above this threshold are flagged as suspicious (packed/encrypted). Default: 7.0
                    </p>
                  </div>

                  {/* Suspicious imports threshold */}
                  <div className="form-group">
                    <label className="form-label">
                      Suspicious imports threshold: {suspiciousImportsThreshold}%
                    </label>
                    <Controller
                      name="heuristics.suspiciousImportsThreshold"
                      control={control}
                      render={({ field }) => (
                        <Slider
                          min={0}
                          max={100}
                          step={5}
                          value={field.value}
                          onChange={field.onChange}
                          marks={{ 0: '0%', 50: '50%', 100: '100%' }}
                          railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
                          trackStyle={{ backgroundColor: '#f59e0b', height: 6 }}
                          handleStyle={{
                            backgroundColor: '#f59e0b',
                            border: 'none',
                            width: 18,
                            height: 18,
                            marginTop: -6,
                          }}
                        />
                      )}
                    />
                    <p className="form-description">
                      Percentage of suspicious API imports required to flag a file. Default: 30%
                    </p>
                  </div>

                  {/* Risk score threshold */}
                  <div className="form-group">
                    <label className="form-label">
                      Risk score threshold: {riskScoreThreshold}
                    </label>
                    <Controller
                      name="heuristics.riskScoreThreshold"
                      control={control}
                      render={({ field }) => (
                        <Slider
                          min={0}
                          max={100}
                          step={1}
                          value={field.value}
                          onChange={field.onChange}
                          marks={{ 0: '0', 50: '50', 100: '100' }}
                          railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
                          trackStyle={{ backgroundColor: '#ef4444', height: 6 }}
                          handleStyle={{
                            backgroundColor: '#ef4444',
                            border: 'none',
                            width: 18,
                            height: 18,
                            marginTop: -6,
                          }}
                        />
                      )}
                    />
                    <p className="form-description">
                      Minimum risk score to flag a file as a threat. Default: 60
                    </p>
                  </div>
                </Disclosure.Panel>
              </>
            )}
          </Disclosure>

          {/* Analysis techniques */}
          <Disclosure defaultOpen>
            {({ open }) => (
              <>
                <Disclosure.Button className="disclosure-button">
                  <span>Analysis Techniques</span>
                  <FiChevronDown className={`disclosure-icon ${open ? 'open' : ''}`} />
                </Disclosure.Button>
                <Disclosure.Panel className="disclosure-panel">
                  <div className="checkbox-grid">
                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        {...register('heuristics.checkPEStructure')}
                      />
                      <span className="checkbox-label">PE Structure Analysis</span>
                    </label>

                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        {...register('heuristics.checkEntropy')}
                      />
                      <span className="checkbox-label">Entropy Detection</span>
                    </label>

                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        {...register('heuristics.checkSignatures')}
                      />
                      <span className="checkbox-label">Code Signatures</span>
                    </label>

                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        {...register('heuristics.checkStrings')}
                      />
                      <span className="checkbox-label">String Analysis</span>
                    </label>

                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        {...register('heuristics.checkBehavior')}
                      />
                      <span className="checkbox-label">Behavioral Analysis</span>
                    </label>
                  </div>
                  <p className="form-description">
                    Select which analysis techniques to apply during heuristic scanning. More techniques = better detection but slower scans.
                  </p>
                </Disclosure.Panel>
              </>
            )}
          </Disclosure>

          {/* Custom rules */}
          <div className="form-group">
            <label className="form-label">Custom heuristic rules path</label>
            <input
              type="text"
              className="form-control"
              placeholder="C:\custom-rules.json"
              {...register('heuristics.customRulesPath')}
            />
            <p className="form-description">
              Path to custom YARA-compatible rules file for advanced threat detection. Leave empty to use default rules.
            </p>
          </div>
        </>
      )}

      <style>{`
        .disclosure-button {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 1rem;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          color: var(--text-primary);
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          margin-bottom: 1rem;
          transition: all 0.2s;
        }

        .disclosure-button:hover {
          border-color: var(--border-hover);
          background: rgba(var(--accent-primary-rgb), 0.05);
        }

        .disclosure-icon {
          width: 20px;
          height: 20px;
          transition: transform 0.2s;
        }

        .disclosure-icon.open {
          transform: rotate(180deg);
        }

        .disclosure-panel {
          padding: 0 0.5rem 1rem 0.5rem;
        }
      `}</style>
    </div>
  );
};
