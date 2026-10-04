import { ServerPanelStatus, useServerPanelData } from './useServerPanelData';
/**
 * List, create, restore, and delete world backups for one server instance.
 */
import { Button } from '../../components/Button';
import React, { useCallback, useState } from 'react';
import { Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useServerError } from './serverErrors';
import './RoomServerPanel.css';

interface ServerBackupPanelProps {
  instanceId: string;
  locked: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const ServerBackupPanel: React.FC<ServerBackupPanelProps> = ({ instanceId, locked }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const api = window.api.rooms.servers;

  const load = useCallback(() => api.backups(instanceId), [api, instanceId]);
  const { data: backups, reload, loading, error, ready } = useServerPanelData(load);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!ready || !backups) return <ServerPanelStatus loading={loading} error={error} reload={reload} />;

  return (
    <div className="room-server-section">
      <p className="room-server-section-intro">{t('rooms.server.backup.intro')}</p>
      {locked && (
        <p className="room-server-note is-warn">{t('rooms.server.stopFirst')}</p>
      )}
      <div className="room-server-backup-create">
        <input
          type="text"
          className="room-server-input"
          placeholder={t('rooms.server.backup.labelPlaceholder')} aria-label={t('rooms.server.backup.labelPlaceholder')}
          value={label}
          disabled={locked || busy}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button size="sm"
          type="button"
          className="room-server-btn" loading={busy}
          disabled={locked}
          onClick={() => void run(async () => {
            await api.createBackup(instanceId, label.trim() || undefined);
            setLabel('');
            toast.success(t('rooms.server.backup.created'));
          })}
        >
          <Icon name="archive" size={12} />
          {t('rooms.server.backup.create')}
        </Button>
        <Button size="sm"
          type="button"
          className="room-server-tool"
          disabled={busy}
          onClick={() => void api.openBackupsFolder(instanceId).catch(err => toast.error(errorText(err)))}
        >
          <Icon name="folder-open" size={12} />
          {t('rooms.server.backup.openFolder')}
        </Button>
      </div>
      {backups.length === 0 ? (
        <p className="room-server-empty">{t('rooms.server.backup.empty')}</p>
      ) : (
        <ul className="room-server-backup-list">
          {backups.map((b) => (
            <li key={b.id} className="room-server-backup-item">
              <div className="room-server-backup-meta">
                <span className="room-server-backup-label">{b.label}</span>
                <span className="room-server-backup-sub">
                  {new Date(b.createdAt).toLocaleString()} · {formatBytes(b.bytes)}
                  {b.auto ? ` · ${t('rooms.server.backup.auto')}` : ''}
                </span>
              </div>
              <div className="room-server-backup-actions">
                {confirmId === b.id ? (
                  <>
                    <Button size="sm"
                      type="button"
                      className="room-server-btn is-danger"
                      disabled={locked || busy}
                      onClick={() => void run(async () => {
                        await api.restoreBackup(instanceId, b.id);
                        setConfirmId(null);
                        toast.success(t('rooms.server.backup.restored'));
                      })}
                    >
                      {t('rooms.server.backup.confirmRestore')}
                    </Button>
                    <Button size="sm" type="button" className="room-server-tool" onClick={() => setConfirmId(null)}>
                      {t('rooms.server.cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm"
                      type="button"
                      className="room-server-tool"
                      disabled={locked || busy}
                      onClick={() => setConfirmId(b.id)}
                    >
                      {t('rooms.server.backup.restore')}
                    </Button>
                    <Button size="sm"
                      type="button"
                      className="room-server-tool is-danger"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await api.deleteBackup(instanceId, b.id);
                        toast.success(t('rooms.server.backup.deleted'));
                      })}
                    >
                      {t('rooms.server.delete')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
