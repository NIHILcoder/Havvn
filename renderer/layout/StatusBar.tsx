/**
 * StatusBar Component
 * 
 * Footer status bar showing global stats.
 */

import React from 'react';
import { Icon } from '../components';

interface StatusBarProps {
  totalDownSpeed?: number;
  totalUpSpeed?: number;
  activeDownloads?: number;
  connectedPeers?: number;
}

const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const StatusBar: React.FC<StatusBarProps> = ({
  totalDownSpeed = 0,
  totalUpSpeed = 0,
  activeDownloads = 0,
  connectedPeers = 0,
}) => {
  return (
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
      
      <div className="status-bar-section">
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
  );
};

export default StatusBar;
