/**
 * CrowdsourcingSettings Section
 */

import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';

export const CrowdsourcingSettings: React.FC = () => {
  const { control, watch } = useFormContext<VirusHuntSettings>();
  
  const enabled = watch('crowdsourcing.enabled');
  const stats = watch('crowdsourcing.contributionStats');

  return (
    <div className="settings-section">
      <h3 className="section-title">Crowdsourced Threat Intelligence</h3>
      <p className="section-description">
        Contribute anonymized threat data to improve detection for all users and receive real-time threat intelligence.
      </p>

      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Enable crowdsourcing</label>
          <Controller
            name="crowdsourcing.enabled"
            control={control}
            render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
          />
        </div>
        <p className="form-description">
          Participate in the threat intelligence network to receive faster protection updates.
        </p>
      </div>

      {enabled && (
        <>
          <div className="form-group">
            <div className="form-label-inline">
              <label className="form-label">Share anonymized data</label>
              <Controller
                name="crowdsourcing.shareAnonymizedData"
                control={control}
                render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
              />
            </div>
            <p className="form-description">
              Share anonymized threat detection data to help improve threat databases. No personal information is transmitted.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label">Your contribution</label>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{stats.scansShared.toLocaleString()}</div>
                <div className="stat-label">Scans Shared</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.threatsReported.toLocaleString()}</div>
                <div className="stat-label">Threats Reported</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.falsePositivesReported.toLocaleString()}</div>
                <div className="stat-label">False Positives</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.reputationScore}</div>
                <div className="stat-label">Reputation Score</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
