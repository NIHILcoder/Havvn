/**
 * Bind room file folders to server content slots (mods/plugins/datapacks) and
 * sync them into the instance directory.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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

  const [state, setState] = useState<ServerContentState>(EMPTY);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reload = useCallback(async () => {
    const [content, roomFolders] = await Promise.all([
      api.content(instanceId),
      api.roomFolders(roomId),
    ]);
    if (!alive.current) return;
    setState(content);
    setFolders(roomFolders);
  }, [api, instanceId, roomId]);

  // Follows the instance: both the sync status and `locked` move when the room
  // manifest changes or the server starts, and this panel used to show whatever
  // it read at mount until the user navigated away and back.
  useEffect(() => {
    void reload().catch(() => { /* panel may mount before instance exists */ });
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
    try {
      await api.setContentFolder(instanceId, slotId, folderId);
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const onUnbind = async (slotId: string) => {
    try {
      await api.clearContentFolder(instanceId, slotId);
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const onSync = async () => {
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
    if (!hashes.length) return;
    setBusy(true);
    try {
      await api.consentContent(hashes);
      const next = await api.syncContent(instanceId);
      setState(next);
      toast.success(t('rooms.server.content.synced'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

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
          <button type="button" className="room-server-btn" disabled={busy} onClick={() => void onConsentAll()}>
            {t('rooms.server.content.consentAccept')}
          </button>
        </div>
      )}

      {/* Sync MIRRORS the bound folders: anything in a slot directory that the
          room does not list is deleted. A hand-installed mod is exactly that,
          and losing one without warning is not a trade the user agreed to. */}
      <p className="room-server-note is-warn">{t('rooms.server.content.mirrorWarning')}</p>

      <div className="room-server-content-actions">
        <button
          type="button"
          className="room-server-primary"
          disabled={locked || busy || !anyBound}
          onClick={() => void onSync()}
        >
          <Icon name="refresh-cw" size={12} />
          {busy ? t('rooms.server.content.syncing') : t('rooms.server.content.syncNow')}
        </button>
        {locked && <p className="room-server-muted">{t('rooms.server.content.stopFirst')}</p>}
      </div>
    </div>
  );
};
