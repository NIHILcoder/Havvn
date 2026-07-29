/**
 * Settings → Downloads section (new card-based layout).
 *
 * Ports the old renderDownloadSettings(): default download directory, max
 * active downloads, watch folder (enable + path + delete-after-add),
 * auto-move-completed (enable + path) and the disk-space guard (enable + min
 * free MB), now reading everything from useSettings() and rendered on the
 * shared SettingsCard/SettingRow primitives. Toggles keep auto-saving through
 * ctx.applyToggle with the same patches and side-effects as before.
 */

import React from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, NumberField, TextField } from '../controls';
import { Button, Icon, Toggle } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';

export const DownloadsSection: React.FC = () => {
  const { t } = useTranslation();
  const {
    defaultDownloadDir, setDefaultDownloadDir, handleSelectDirectory,
    maxActiveDownloads, setMaxActiveDownloads,
    applyToggle, applyWatchFolder,
    watchFolderEnabled, setWatchFolderEnabled,
    watchFolderPath, setWatchFolderPath,
    watchFolderDeleteAfterAdd, setWatchFolderDeleteAfterAdd,
    clipboardWatchEnabled, setClipboardWatchEnabled,
    autoMoveEnabled, setAutoMoveEnabled,
    autoMovePath, setAutoMovePath,
    diskGuardEnabled, setDiskGuardEnabled,
    diskGuardMinFreeMB, setDiskGuardMinFreeMB,
    engine, runningEngine,
  } = useSettings();

  // Auto-move-on-completion exists only in the webtorrent manager; the native
  // engine has no implementation, so the setting reached it and went unread.
  // Gated on the engine actually RUNNING, like the speed note and the VPN bind:
  // "configured" would promise the feature the moment the picker moved, before
  // the restart that makes it true.
  const autoMoveSupported = (runningEngine ?? engine) === 'webtorrent';

  return (
    <>
      {/* Location + queue limits */}
      <SettingsCard title={t('settings.grp.location')} icon="folder">
        <SettingRow
          label={t('settings.defaultDir')}
          description={t('settings.defaultDir.desc')}
          wide
          control={
            <div className="stg-path">
              <TextField
                value={defaultDownloadDir}
                onChange={setDefaultDownloadDir}
                mono
                ariaLabel={t('settings.defaultDir')}
              />
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="folder-open" size={14} />}
                onClick={handleSelectDirectory}
              >
                {t('settings.choose')}
              </Button>
            </div>
          }
        />
        <SettingRow
          label={t('settings.maxActive')}
          description={t('settings.maxActive.desc')}
          control={
            <NumberField
              value={maxActiveDownloads}
              onChange={(n) => setMaxActiveDownloads(Math.round(n) || 3)}
              min={1}
              max={10}
              ariaLabel={t('settings.maxActive')}
            />
          }
        />
      </SettingsCard>

      {/* Watch folder */}
      <SettingsCard title={t('settings.grp.watchFolder')} icon="eye">
        <SettingRow
          label={t('settings.watchEnable')}
          description={t('settings.watchEnable.desc')}
          control={
            <Toggle
              checked={watchFolderEnabled}
              onChange={(v) =>
                applyToggle(v, setWatchFolderEnabled, { watchFolderEnabled: v },
                  (on) => applyWatchFolder(on, watchFolderDeleteAfterAdd))
              }
              ariaLabel={t('settings.watchEnable')}
            />
          }
        />
        {watchFolderEnabled && (
          <>
            <SettingRow
              label={t('settings.watchPath')}
              description={t('settings.watchPath.desc')}
              wide
              control={
                <div className="stg-path">
                  <TextField
                    value={watchFolderPath}
                    onChange={setWatchFolderPath}
                    placeholder={t('settings.watchPath.placeholder')}
                    mono
                    ariaLabel={t('settings.watchPath')}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="folder-open" size={14} />}
                    onClick={async () => {
                      const p = await window.api.selectDirectory();
                      if (p) setWatchFolderPath(p);
                    }}
                  />
                </div>
              }
            />
            <SettingRow
              label={t('settings.watchDelete')}
              description={t('settings.watchDelete.desc')}
              control={
                <Toggle
                  checked={watchFolderDeleteAfterAdd}
                  onChange={(v) =>
                    applyToggle(v, setWatchFolderDeleteAfterAdd, { watchFolderDeleteAfterAdd: v },
                      (on) => applyWatchFolder(watchFolderEnabled, on))
                  }
                  ariaLabel={t('settings.watchDelete')}
                />
              }
            />
          </>
        )}
      </SettingsCard>

      {/* Clipboard magnet watcher */}
      <SettingsCard title={t('settings.grp.clipboard')} icon="copy">
        <SettingRow
          label={t('settings.clipboardWatch')}
          description={t('settings.clipboardWatch.desc')}
          control={
            <Toggle
              checked={clipboardWatchEnabled}
              onChange={(v) => applyToggle(v, setClipboardWatchEnabled, { clipboardWatchEnabled: v })}
              ariaLabel={t('settings.clipboardWatch')}
            />
          }
        />
      </SettingsCard>

      {/* Auto-move completed */}
      <SettingsCard title={t('settings.grp.autoMove')} icon="arrow-right">
        {/* Disabled WITH ITS REASON rather than hidden. A control that vanishes
            teaches nothing — a native-engine user would never learn the feature
            exists, nor that the classic engine has it. Same treatment the
            native-only VPN bind gets in Privacy, inverted. */}
        <SettingRow
          label={t('settings.autoMove')}
          description={autoMoveSupported ? t('settings.autoMove.desc') : t('settings.autoMove.engineOnly')}
          control={
            <Toggle
              checked={autoMoveEnabled && autoMoveSupported}
              disabled={!autoMoveSupported}
              onChange={(v) => applyToggle(v, setAutoMoveEnabled, { autoMoveEnabled: v })}
              ariaLabel={t('settings.autoMove')}
            />
          }
        />
        {/* The path row would be dead weight under an unavailable feature — and
            a stored `autoMoveEnabled: true` from a webtorrent session survives
            the engine switch, so this cannot lean on the toggle alone. */}
        {autoMoveSupported && autoMoveEnabled && (
          <SettingRow
            label={t('settings.autoMovePath')}
            description={t('settings.autoMovePath.desc')}
            wide
            control={
              <div className="stg-path">
                <TextField
                  value={autoMovePath}
                  onChange={setAutoMovePath}
                  placeholder={t('settings.autoMovePath.placeholder')}
                  mono
                  ariaLabel={t('settings.autoMovePath')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Icon name="folder-open" size={14} />}
                  onClick={async () => {
                    const p = await window.api.selectDirectory();
                    if (p) setAutoMovePath(p);
                  }}
                />
              </div>
            }
          />
        )}
      </SettingsCard>

      {/* Disk-space guard */}
      <SettingsCard title={t('settings.grp.diskGuard')} icon="hard-drive">
        <SettingRow
          label={t('settings.diskGuard')}
          description={t('settings.diskGuard.desc')}
          control={
            <Toggle
              checked={diskGuardEnabled}
              onChange={(v) => applyToggle(v, setDiskGuardEnabled, { diskGuardEnabled: v })}
              ariaLabel={t('settings.diskGuard')}
            />
          }
        />
        {diskGuardEnabled && (
          <SettingRow
            label={t('settings.diskMin')}
            description={t('settings.diskMin.desc')}
            control={
              <NumberField
                value={diskGuardMinFreeMB}
                onChange={(n) => setDiskGuardMinFreeMB(Math.round(n) || 2048)}
                unit="MB"
                min={100}
                step={256}
                ariaLabel={t('settings.diskMin')}
              />
            }
          />
        )}
      </SettingsCard>
    </>
  );
};
