/**
 * NotificationSettings Section
 */

import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { VirusHuntSettings } from '../../../../shared/virushunt-settings-types';
import { Toggle } from '../../Toggle';

export const NotificationSettings: React.FC = () => {
  const { control, register, watch } = useFormContext<VirusHuntSettings>();
  
  const enabled = watch('notifications.enabled');

  return (
    <div className="settings-section">
      <h3 className="section-title">Notifications</h3>
      <p className="section-description">
        Configure how and when you receive notifications about scan results and threats.
      </p>

      <div className="form-group">
        <div className="form-label-inline">
          <label className="form-label">Enable notifications</label>
          <Controller
            name="notifications.enabled"
            control={control}
            render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
          />
        </div>
      </div>

      {enabled && (
        <>
          <div className="form-group">
            <div className="form-label-inline">
              <label className="form-label">Sound alerts</label>
              <Controller
                name="notifications.soundEnabled"
                control={control}
                render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Notification type</label>
            <select className="form-control" {...register('notifications.notificationType')}>
              <option value="all">All scan results</option>
              <option value="threats-only">Threats only</option>
              <option value="critical-only">Critical threats only</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Priority</label>
            <select className="form-control" {...register('notifications.priority')}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High (with banner)</option>
            </select>
          </div>

          <div className="form-group">
            <div className="form-label-inline">
              <label className="form-label">Desktop notifications</label>
              <Controller
                name="notifications.showDesktop"
                control={control}
                render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
              />
            </div>
          </div>

          <div className="form-group">
            <div className="form-label-inline">
              <label className="form-label">In-app notifications</label>
              <Controller
                name="notifications.showInApp"
                control={control}
                render={({ field }) => <Toggle checked={field.value} onChange={field.onChange} />}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};
