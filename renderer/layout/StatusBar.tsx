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

/** The single most-alive room right now, computed in App from rooms data. */
export interface RoomPresence {
  roomId: string;
  name: string;
  othersOnline: number; // online members besides yourself
  watching: boolean;    // a watch-together sync happened recently
}

interface StatusBarProps {
  totalDownSpeed?: number;
  totalUpSpeed?: number;
  activeDownloads?: number;
  connectedPeers?: number;
  roomPresence?: RoomPresence | null;
  onJoinRoom?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  totalDownSpeed = 0,
  totalUpSpeed = 0,
  activeDownloads = 0,
  connectedPeers = 0,
  roomPresence = null,
  onJoinRoom,
}) => {
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
            <span>Connected</span>
          </div>
          <div className="status-item">
            <Icon name="activity" size={12} />
            <span>{activeDownloads} active</span>
          </div>
          <div className="status-item">
            <Icon name="users" size={12} />
            <span>{connectedPeers} peers</span>
          </div>
        </div>

        {roomPresence && (
          <div className="status-bar-section status-presence" title={`${roomPresence.name} — open Rooms`}>
            <span className="presence-dot" />
            <span className="presence-text">
              <b>{roomPresence.name}</b>
              <span className="presence-detail">
                {roomPresence.watching
                  ? ' — watching together'
                  : ` — ${roomPresence.othersOnline} online`}
              </span>
            </span>
            <button className="presence-join" onClick={onJoinRoom}>
              Join →
            </button>
          </div>
        )}

        <div className="status-bar-section">
          <button
            className="status-graph-btn"
            onClick={() => setShowGraph(!showGraph)}
            title={showGraph ? 'Hide graph' : 'Show speed graph'}
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
