/**
 * PerformanceSettings Section
 */

import React from 'react';
import { useFormContext, Controller, useFieldArray } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';
import { Button } from '../../Button';
import { FiPlus, FiTrash2 } from 'react-icons/fi';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';

export const PerformanceSettings: React.FC = () => {
  const { control, register, watch } = useFormContext<VirusHuntSettings>();
  
  const parallelScans = watch('performance.parallelScans');
  const maxMemoryUsage = watch('performance.maxMemoryUsage');
  const cpuLimit = watch('performance.cpuLimit');

  const scheduledScans = useFieldArray({
    control,
    name: 'performance.scheduledScans',
  });

  const daysOfWeek = [
    { value: 'mon', label: 'Mon' },
    { value: 'tue', label: 'Tue' },
    { value: 'wed', label: 'Wed' },
    { value: 'thu', label: 'Thu' },
    { value: 'fri', label: 'Fri' },
    { value: 'sat', label: 'Sat' },
    { value: 'sun', label: 'Sun' },
  ];

  return (
    <div className="settings-section">
      <h3 className="section-title">Performance & Scheduling</h3>
      <p className="section-description">
        Optimize scan performance and configure scheduled scans.
      </p>

      {/* Parallel scans */}
      <div className="form-group">
        <label className="form-label">Parallel scans: {parallelScans}</label>
        <Controller
          name="performance.parallelScans"
          control={control}
          render={({ field }) => (
            <Slider
              min={1}
              max={10}
              step={1}
              value={field.value}
              onChange={field.onChange}
              marks={{ 1: '1', 5: '5', 10: '10' }}
              railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
              trackStyle={{ backgroundColor: '#3b82f6', height: 6 }}
              handleStyle={{ backgroundColor: '#3b82f6', border: 'none', width: 18, height: 18, marginTop: -6 }}
            />
          )}
        />
        <p className="form-description">
          Number of files to scan simultaneously. Higher values = faster scans but more CPU usage.
        </p>
      </div>

      {/* Background priority */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Low background priority</label>
          <Controller
            name="performance.backgroundPriority"
            control={control}
            render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
          />
        </div>
        <p className="form-description">
          Run scans at lower CPU priority to avoid impacting other applications.
        </p>
      </div>

      {/* Max memory */}
      <div className="form-group">
        <label className="form-label">Max memory usage: {maxMemoryUsage} MB</label>
        <Controller
          name="performance.maxMemoryUsage"
          control={control}
          render={({ field }) => (
            <Slider
              min={128}
              max={4096}
              step={128}
              value={field.value}
              onChange={field.onChange}
              marks={{ 128: '128 MB', 2048: '2 GB', 4096: '4 GB' }}
              railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
              trackStyle={{ backgroundColor: '#f59e0b', height: 6 }}
              handleStyle={{ backgroundColor: '#f59e0b', border: 'none', width: 18, height: 18, marginTop: -6 }}
            />
          )}
        />
      </div>

      {/* CPU limit */}
      <div className="form-group">
        <label className="form-label">CPU limit: {cpuLimit}%</label>
        <Controller
          name="performance.cpuLimit"
          control={control}
          render={({ field }) => (
            <Slider
              min={10}
              max={100}
              step={10}
              value={field.value}
              onChange={field.onChange}
              marks={{ 10: '10%', 50: '50%', 100: '100%' }}
              railStyle={{ backgroundColor: '#e5e7eb', height: 6 }}
              trackStyle={{ backgroundColor: '#ef4444', height: 6 }}
              handleStyle={{ backgroundColor: '#ef4444', border: 'none', width: 18, height: 18, marginTop: -6 }}
            />
          )}
        />
      </div>

      {/* Scheduled scans */}
      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Scheduled scans</label>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => scheduledScans.append({
              id: crypto.randomUUID(),
              enabled: true,
              time: '03:00',
              days: ['mon', 'wed', 'fri'],
              targetPath: 'C:\\Downloads',
            })}
            icon={<FiPlus />}
          >
            Add Schedule
          </Button>
        </div>

        <div className="scheduled-scans-list">
          {scheduledScans.fields.map((field, index) => (
            <div key={field.id} className="scheduled-scan-item">
              <div className="scan-header">
                <Controller
                  name={`performance.scheduledScans.${index}.enabled`}
                  control={control}
                  render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
                />
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => scheduledScans.remove(index)}
                  icon={<FiTrash2 />}
                >
                  Remove
                </Button>
              </div>

              <div className="scan-controls">
                <div className="form-group">
                  <label className="form-label">Time</label>
                  <input
                    type="time"
                    className="form-control"
                    {...register(`performance.scheduledScans.${index}.time`)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Target path</label>
                  <input
                    type="text"
                    className="form-control"
                    {...register(`performance.scheduledScans.${index}.targetPath`)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Days</label>
                  <div className="days-grid">
                    {daysOfWeek.map((day) => (
                      <label key={day.value} className="day-checkbox">
                        <input
                          type="checkbox"
                          value={day.value}
                          {...register(`performance.scheduledScans.${index}.days`)}
                        />
                        <span>{day.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .scheduled-scans-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          margin-top: 1rem;
        }

        .scheduled-scan-item {
          padding: 1rem;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 8px;
        }

        .scan-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid var(--border-color);
        }

        .scan-controls {
          display: grid;
          gap: 1rem;
        }

        .days-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.5rem;
        }

        .day-checkbox {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
          padding: 0.5rem;
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.75rem;
        }

        .day-checkbox:has(input:checked) {
          background: var(--accent-primary);
          color: white;
          border-color: var(--accent-primary);
        }
      `}</style>
    </div>
  );
};
