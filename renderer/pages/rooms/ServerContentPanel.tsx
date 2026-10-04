import { ServerPanelStatus, useServerPanelData } from './useServerPanelData';
/**
 * Bind room file folders to server content slots (mods/plugins/datapacks) and
 * sync them into the instance directory.
 */
import { Button } from '../../components/Button';
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Select } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import type { ServerContentState } from '../../../shared/gameserver-types';
import { useServerError } from './serverErrors';
import './RoomServerPanel.css';

interface ServerContentPanelProps {
  roomId: string;
  instanceId: string;
  locked: boolean;
}

const EMPTY: ServerContentState = { slots: [], sync: 'ok', pending: [] };

export const ServerContentPanel: React.FC<ServerContentPanelProps> = ({ roomId, instanceId, locked }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const api = window.api.rooms.servers;

  const load = useCallback(() => Promise.all([api.content(instanceId), api.roomFolders(roomId)]), [api, instanceId, roomId]);
  const { data, setData, reload, loading, error, ready } = useServerPanelData(load);
  const state = data?.[0] ?? EMPTY;
  const folders = data?.[1] ?? [];
  const setState = (next: ServerContentState) => setData(prev => prev ? [next, prev[1]] : prev);
  const [busy, setBusy] = useState(false);

  // Follows the instance: both the sync status and `locked` move when the room
  // manifest changes or the server starts, and this panel used to show whatever
  // it read at mount until the user navigated away and back.
  useEffect(() => {
    const off = api.onUpdate((payload) => {
      if (payload.state.instances.some((i) => i.instanceId === instanceId)) {
        void reload().catch(() => { /* ignore */ });
      }
    });
    return off;
  }, [api, instanceId, reload]);

  const folderOptions = [
    { value: '', label: t('rooms.server.content.uncategorized') },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  const onBind = async (slotId: string, folderId: string) => {
    if (busy || locked || !ready) return;
    setBusy(true);
    try {
      await api.setContentFolder(instanceId, slotId, folderId);
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  const onUnbind = async (slotId: string) => {
    if (busy || locked || !ready) return;
    setBusy(true);
    try {
      await api.clearContentFolder(instanceId, slotId);
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally { setBusy(false); }
  };

  const onSync = async () => {
    if (busy || locked || !ready) return;
    setBusy(true);
    try {
      const next = await api.syncContent(instanceId);
      setState(next);
      if (next.pending.length === 0 && next.sync === 'ok') {
        toast.success(t('rooms.server.content.synced'));
      } else if (next.sync === 'missing') {
        toast.error(t('rooms.server.content.sync.missing'));
      }
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const onConsentAll = async () => {
    const hashes = state.pending.map((p) => p.sha256);
    if (!hashes.length || busy || locked || !ready) return;
    setBusy(true);
    try {
      await api.consentContent(hashes);
      const next = await api.syncContent(instanceId);
      setState(next);
      if (next.pending.length === 0 && next.sync === 'ok') toast.success(t('rooms.server.content.synced'));
      else toast.error(t(`rooms.server.content.sync.${next.sync}` as never));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <ServerPanelStatus loading={loading} error={error} reload={reload} />;

  if (!state.slots.length) {
    return <p className="room-server-muted">{t('rooms.server.content.none')}</p>;
  }

  const anyBound = state.slots.some((s) => s.bound);

  return (
    <div className="room-server-content">
      <p className="room-server-content-intro">{t('rooms.server.content.intro')}</p>

      {state.sync !== 'ok' && (
        <div className={`room-server-content-badge is-${state.sync}`} role="status">
          <Icon name="alert-circle" size={12} />
          {t(`rooms.server.content.sync.${state.sync}` as never)}
        </div>
      )}

      <ul className="room-server-content-slots">
        {state.slots.map((slot) => (
            <li key={slot.slotId} className="room-server-content-slot">
              <div className="room-server-content-slot-head">
                <span className="room-server-content-slot-title">{t(slot.labelKey as never)}</span>
                {slot.executable && (
                  <span className="room-server-content-tag">{t('rooms.server.content.executable')}</span>
                )}
              </div>
              <Select
                ariaLabel={t(slot.labelKey as never)}
                value={slot.bound ? slot.folderId : '__unbound__'}
                options={[
                  { value: '__unbound__', label: t('rooms.server.content.unbound') },
                  ...folderOptions,
                ]}
                disabled={locked || busy}
                onChange={(v) => {
                  if (v === '__unbound__') void onUnbind(slot.slotId);
                  else void onBind(slot.slotId, v);
                }}
              />
              <span className="room-server-content-count">
                {slot.bound
                  ? t('rooms.server.content.fileCount')
                    .replace('{ready}', String(slot.readyCount))
                    .replace('{total}', String(slot.fileCount))
                  : t('rooms.server.content.notBound')}
              </span>
            </li>
          ))}
      </ul>

      {state.pending.length > 0 && (
        <div className="room-server-content-pending" role="alert">
          <p>{t('rooms.server.content.consentIntro')}</p>
          <ul>
            {state.pending.map((p) => (
              <li key={p.sha256}>{p.name}</li>
            ))}
          </ul>
          <Button size="sm" type="button" className="room-server-btn" loading={busy} disabled={locked} onClick={() => void onConsentAll()}>
            {t('rooms.server.content.consentAccept')}
          </Button>
        </div>
      )}

      {/* Sync MIRRORS the bound folders: anything in a slot directory that the
          room does not list is deleted. A hand-installed mod is exactly that,
          and losing one without warning is not a trade the user agreed to. */}
      <p className="room-server-note is-warn">{t('rooms.server.content.mirrorWarning')}</p>

      <div className="room-server-content-actions">
        <Button size="sm"
          type="button"
          variant="primary" className="room-server-primary" loading={busy}
          disabled={locked || !anyBound}
          onClick={() => void onSync()}
        >
          <Icon name="refresh-cw" size={12} />
          {busy ? t('rooms.server.content.syncing') : t('rooms.server.content.syncNow')}
        </Button>
        {locked && <p className="room-server-muted">{t('rooms.server.content.stopFirst')}</p>}
      </div>
    </div>
  );
};
