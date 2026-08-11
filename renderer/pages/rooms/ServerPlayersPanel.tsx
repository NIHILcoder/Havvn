/**
 * Whitelist and ban list editor for Minecraft servers.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import type { ServerPlayersState } from '../../../shared/gameserver-types';
import { useServerError } from './serverErrors';
import './RoomServerPanel.css';

interface ServerPlayersPanelProps {
  instanceId: string;
}

const EMPTY: ServerPlayersState = {
  whitelistEnabled: false,
  whitelist: [],
  banned: [],
  locked: false,
};

export const ServerPlayersPanel: React.FC<ServerPlayersPanelProps> = ({ instanceId }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const api = window.api.rooms.servers;

  const [state, setState] = useState<ServerPlayersState>(EMPTY);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setState(await api.players(instanceId));
  }, [api, instanceId]);

  // `locked` comes from whether the server is running, so this has to follow the
  // instance: fetching once on mount left every control enabled after a start,
  // and the save then failed with `stop-first` instead of being greyed out.
  useEffect(() => {
    void reload().catch(() => { /* instance may be gone */ });
    const off = api.onUpdate((payload) => {
      if (payload.state.instances.some((i) => i.instanceId === instanceId)) {
        void reload().catch(() => { /* ignore */ });
      }
    });
    return off;
  }, [api, instanceId, reload]);

  const save = async (patch: Parameters<typeof api.savePlayers>[1]) => {
    setBusy(true);
    try {
      await api.savePlayers(instanceId, patch);
      await reload();
      toast.success(t('rooms.server.players.saved'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const addWhitelist = () => {
    const name = newName.trim();
    if (!name || state.locked) return;
    if (state.whitelist.some((e) => e.name.toLowerCase() === name.toLowerCase())) return;
    void save({ whitelist: [...state.whitelist, { uuid: '', name }], whitelistEnabled: state.whitelistEnabled });
    setNewName('');
  };

  return (
    <div className="room-server-section">
      <p className="room-server-section-intro">{t('rooms.server.players.intro')}</p>
      {/* A name typed here is written with the null UUID, because nothing offline
          can turn a name into a Mojang account id. An online-mode server matches
          whitelist entries by UUID, so it will ignore these — say so rather than
          let the entry look like it took effect. */}
      <p className="room-server-note">{t('rooms.server.players.uuidNote')}</p>
      {state.locked && (
        <p className="room-server-note is-warn">{t('rooms.server.players.locked')}</p>
      )}
      <div className="room-server-setting">
        <span className="room-server-setting-text">
          <span className="room-server-setting-title">{t('rooms.server.cfg.whitelist')}</span>
          <span className="room-server-setting-hint">{t('rooms.server.players.whitelistHint')}</span>
        </span>
        <Toggle
          checked={state.whitelistEnabled}
          ariaLabel={t('rooms.server.cfg.whitelist')}
          disabled={busy || state.locked}
          onChange={(checked) => void save({ whitelistEnabled: checked })}
        />
      </div>
      <div className="room-server-players-add">
        <input
          type="text"
          className="room-server-input"
          placeholder={t('rooms.server.players.namePlaceholder')}
          value={newName}
          disabled={busy || state.locked}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addWhitelist(); }}
        />
        <button type="button" className="room-server-btn" disabled={busy || state.locked} onClick={addWhitelist}>
          <Icon name="user" size={12} />
          {t('rooms.server.players.add')}
        </button>
      </div>
      <h4 className="room-server-subhead">{t('rooms.server.players.whitelist')}</h4>
      {state.whitelist.length === 0 ? (
        <p className="room-server-empty">{t('rooms.server.players.whitelistEmpty')}</p>
      ) : (
        <ul className="room-server-player-list">
          {state.whitelist.map((p) => (
            <li key={p.uuid || p.name} className="room-server-player-item">
              <span>{p.name}</span>
              <button
                type="button"
                className="room-server-tool is-danger"
                disabled={busy || state.locked}
                onClick={() => void save({
                  whitelist: state.whitelist.filter((e) => e.name !== p.name),
                  whitelistEnabled: state.whitelistEnabled,
                })}
              >
                {t('rooms.server.players.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4 className="room-server-subhead">{t('rooms.server.players.banned')}</h4>
      {state.banned.length === 0 ? (
        <p className="room-server-empty">{t('rooms.server.players.bannedEmpty')}</p>
      ) : (
        <ul className="room-server-player-list">
          {state.banned.map((p) => (
            <li key={p.uuid || p.name} className="room-server-player-item">
              <span>{p.name}</span>
              <button
                type="button"
                className="room-server-tool"
                disabled={busy || state.locked}
                onClick={() => void save({ banned: state.banned.filter((e) => e.name !== p.name) })}
              >
                {t('rooms.server.players.unban')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
