/**
 * Notifications settings section — four auto-saving toggles ported from the
 * old renderNotificationSettings() in SettingsPage.tsx.
 */
import React from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow } from '../controls';
import { Toggle } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { NotificationPolicyPanel } from './NotificationPolicyPanel';

export const NotificationsSection: React.FC = () => {
  const { t } = useTranslation();
  const ctx = useSettings();

  return (
    <><SettingsCard title={t('settings.grp.notifications')} icon="bell">
      <SettingRow
        label={t('settings.notif.enable')}
        description={t('settings.notif.enable.desc')}
        control={
          <Toggle
            checked={ctx.enableNotifications}
            onChange={() =>
              ctx.applyToggle(!ctx.enableNotifications, ctx.setEnableNotifications, {
                enableNotifications: !ctx.enableNotifications,
              })
            }
          />
        }
      />
      <SettingRow
        label={t('settings.notif.sounds')}
        description={t('settings.notif.sounds.desc')}
        control={
          <Toggle
            checked={ctx.enableSounds}
            onChange={() =>
              ctx.applyToggle(!ctx.enableSounds, ctx.setEnableSounds, {
                enableSounds: !ctx.enableSounds,
              })
            }
          />
        }
      />
      <SettingRow
        label={t('settings.notif.complete')}
        description={t('settings.notif.complete.desc')}
        control={
          <Toggle
            checked={ctx.notifyOnComplete}
            onChange={() =>
              ctx.applyToggle(!ctx.notifyOnComplete, ctx.setNotifyOnComplete, {
                notifyOnComplete: !ctx.notifyOnComplete,
              })
            }
          />
        }
      />
      <SettingRow
        label={t('settings.notif.error')}
        description={t('settings.notif.error.desc')}
        control={
          <Toggle
            checked={ctx.notifyOnError}
            onChange={() =>
              ctx.applyToggle(!ctx.notifyOnError, ctx.setNotifyOnError, {
                notifyOnError: !ctx.notifyOnError,
              })
            }
          />
        }
      />
    </SettingsCard>
    {ctx.settings && <NotificationPolicyPanel settings={ctx.settings} onSaved={ctx.setSettings} />}
    </>
  );
};
