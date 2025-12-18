/**
 * Badge Component
 */

import React from 'react';
import { DownloadStatus } from '../../shared/types';
import { getStatusDisplayText } from '../../shared/state-machine';
import { Icon, IconName } from './Icon';

interface BadgeProps {
  children?: React.ReactNode;
  variant?: 'default' | DownloadStatus;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  className = '',
}) => {
  const variantClass = variant !== 'default' ? `badge-${variant}` : '';
  
  return (
    <span className={`badge ${variantClass} ${className}`}>
      {children}
    </span>
  );
};

// Convenience component for status badges with icons
interface StatusBadgeProps {
  status: DownloadStatus;
  className?: string;
  showIcon?: boolean;
}

const getStatusIcon = (status: DownloadStatus): IconName => {
  switch (status) {
    case 'downloading':
      return 'download';
    case 'completed':
      return 'check-circle';
    case 'seeding':
      return 'upload';
    case 'paused':
      return 'pause';
    case 'error':
      return 'alert-circle';
    case 'queued':
      return 'clock';
    case 'removed':
      return 'trash';
    default:
      return 'info';
  }
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ 
  status, 
  className = '',
  showIcon = true 
}) => {
  return (
    <Badge variant={status} className={`status-badge ${className}`}>
      {showIcon && <Icon name={getStatusIcon(status)} size={12} />}
      <span>{getStatusDisplayText(status)}</span>
    </Badge>
  );
};

export default Badge;
