/**
 * StatusBar Component
 *
 * Footer status bar showing global stats with expandable speed graph.
 * Also the persistent bridge between the two pillars: when friends are online
 * (or watching together) in a room, a presence chip appears with a one-click
 * jump into Rooms — so the social world stays visible from Transfers.
 */

import React, { useState } from 'react';
import { Icon, SpeedGraph } from '../components';
import { formatSpeed } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';

/** The single most-alive room right now, computed in App from rooms data. */
export interface RoomPresence {
  roomId: string;
  name: string;
  othersOnline: number; // online members besides yourself
  watching: boolean;    // a watch-together sync happened recently
}

/** The active voice call (audio keeps running when the Rooms page unmounts). */
export interface VoiceCallInfo {
  roomId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
}

interface StatusBarProps {
  totalDownSpeed?: number;
  totalUpSpeed?: number;
  activeDownloads?: number;
  connectedPeers?: number;
  roomPresence?: RoomPresence | null;
  onJoinRoom?: () => void;
  voiceCall?: VoiceCallInfo | null;
  onOpenVoiceRoom?: () => void;
  onVoiceMute?: () => void;
  onVoiceDeafen?: () => void;
  onVoiceLeave?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  totalDownSpeed = 0,
  totalUpSpeed = 0,
  activeDownloads = 0,
  connectedPeers = 0,
  roomPresence = null,
  onJoinRoom,
  voiceCall = null,
  onOpenVoiceRoom,
  onVoiceMute,
  onVoiceDeafen,
  onVoiceLeave,
}) => {
  const { t } = useTranslation();
  const [showGraph, setShowGraph] = useState(false);

  return (
    <div className="status-bar-container">
      {showGraph && (
        <div className="status-bar-graph">
          <SpeedGraph
            downloadSpeed={totalDownSpeed}
            uploadSpeed={totalUpSpeed}
            height={100}
          />
        </div>
      )}
      <footer className="status-bar">
        <div className="status-bar-section">
          <div className="status-item">
            <span className="status-dot status-dot-connected" />
            <span>{t('statusbar.connected')}</span>
          </div>
          <div className="status-item">
            <Icon name="activity" size={12} />
            <span>{activeDownloads} {t('statusbar.active')}</span>
          </div>
          <div className="status-item">
            <Icon name="users" size={12} />
            <span>{connectedPeers} {t('downloads.peersShort')}</span>
          </div>
        </div>

        {/* The live call cluster — audio continues on every page, so its
            controls must too: room name (jump), mic, deafen, hang up. */}
        {voiceCall && (
          <div className="status-bar-section status-voice-call">
            <span className={`status-voice-dot${voiceCall.muted ? ' muted' : ''}`} />
            <button className="status-voice-name" onClick={onOpenVoiceRoom} title={t('statusbar.openCall')}>
              <Icon name="headphones" size={12} /> {voiceCall.name}
            </button>
            <button
              className={`status-voice-btn${voiceCall.muted ? ' active' : ''}`}
              onClick={onVoiceMute}
              title={voiceCall.muted ? t('rooms.voice.unmute') : t('rooms.voice.mute')}
            >
              <Icon name={voiceCall.muted ? 'mic-off' : 'mic'} size={12} />
            </button>
            <button
              className={`status-voice-btn${voiceCall.deafened ? ' active' : ''}`}
              onClick={onVoiceDeafen}
              title={voiceCall.deafened ? t('rooms.voice.undeafen') : t('rooms.voice.deafen')}
            >
              <Icon name={voiceCall.deafened ? 'volume-x' : 'headphones'} size={12} />
            </button>
            <button className="status-voice-btn leave" onClick={onVoiceLeave} title={t('rooms.voice.leave')}>
              <Icon name="phone-off" size={12} />
            </button>
          </div>
        )}

        {roomPresence && !voiceCall && (
          <div className="status-bar-section status-presence" title={`${roomPresence.name} — ${t('statusbar.openRooms')}`}>
            <span className="presence-dot" />
            <span className="presence-text">
              <b>{roomPresence.name}</b>
              <span className="presence-detail">
                {roomPresence.watching
                  ? ` — ${t('statusbar.watchingTogether')}`
                  : ` — ${roomPresence.othersOnline} ${t('rooms.rail.online')}`}
              </span>
            </span>
            <button className="presence-join" onClick={onJoinRoom}>
              {t('rooms.join')} →
            </button>
          </div>
        )}

        <div className="status-bar-section">
          <button
            className="status-graph-btn"
            onClick={() => setShowGraph(!showGraph)}
            title={showGraph ? t('statusbar.hideGraph') : t('statusbar.showGraph')}
          >
            <Icon name="activity" size={14} />
          </button>
          <div className="status-item status-item-download">
            <Icon name="download" size={12} />
            <span>{formatSpeed(totalDownSpeed)}</span>
          </div>
          <div className="status-item status-item-upload">
            <Icon name="upload" size={12} />
            <span>{formatSpeed(totalUpSpeed)}</span>
          </div>
        </div>
      </footer>
    </div>
  );
};


export default StatusBar;
