/**
 * Security Indicator Component
 * 
 * Displays security status icon with tooltip for torrents.
 */

import React, { useState, useRef, useEffect } from 'react';
import { Icon } from './Icon';
import { useVirusHunt, TorrentSecurityStatus } from '../contexts/VirusHuntContext';
import './SecurityIndicator.css';

interface SecurityIndicatorProps {
  torrentId: string;
  torrentName?: string;
  onClick?: () => void;
}

export const SecurityIndicator: React.FC<SecurityIndicatorProps> = ({
  torrentId,
  torrentName,
  onClick,
}) => {
  const { getSecurityStatus } = useVirusHunt();
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<'top' | 'bottom'>('top');
  const indicatorRef = useRef<HTMLDivElement>(null);

  const status = getSecurityStatus(torrentId) || {
    infoHash: torrentId,
    status: 'unscanned' as const,
    threatCount: 0,
  };

  useEffect(() => {
    if (showTooltip && indicatorRef.current) {
      const rect = indicatorRef.current.getBoundingClientRect();
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      setTooltipPosition(spaceBelow < 150 && spaceAbove > 150 ? 'top' : 'bottom');
    }
  }, [showTooltip]);

  const getIconAndColor = () => {
    switch (status.status) {
      case 'scanning':
        return { icon: 'loader' as const, color: 'scanning', label: 'Scanning...' };
      case 'safe':
        return { icon: 'check-circle' as const, color: 'safe', label: 'Safe' };
      case 'suspicious':
        return { icon: 'alert-triangle' as const, color: 'suspicious', label: 'Suspicious' };
      case 'dangerous':
        return { icon: 'x-circle' as const, color: 'dangerous', label: 'Dangerous' };
      case 'error':
        return { icon: 'alert-circle' as const, color: 'error', label: 'Scan Error' };
      case 'unscanned':
      default:
        return { icon: 'help-circle' as const, color: 'unscanned', label: 'Not Scanned' };
    }
  };

  const { icon, color, label } = getIconAndColor();

  const formatDate = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  };

  return (
    <div
      ref={indicatorRef}
      className={`security-indicator security-${color}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      role="button"
      tabIndex={0}
    >
      <Icon 
        name={icon} 
        size={16} 
        className={status.status === 'scanning' ? 'spinning' : ''}
      />

      {showTooltip && (
        <div className={`security-tooltip tooltip-${tooltipPosition}`}>
          <div className="tooltip-header">
            <Icon name="shield" size={14} />
            <span className="tooltip-title">Security Status</span>
          </div>

          <div className="tooltip-content">
            <div className="tooltip-row">
              <span className="tooltip-label">Status:</span>
              <span className={`tooltip-value status-${color}`}>{label}</span>
            </div>

            {status.threatCount > 0 && (
              <div className="tooltip-row">
                <span className="tooltip-label">Threats:</span>
                <span className="tooltip-value threat-count">
                  {status.threatCount} detected
                </span>
              </div>
            )}

            {status.lastScanned && (
              <div className="tooltip-row">
                <span className="tooltip-label">Last Scan:</span>
                <span className="tooltip-value">{formatDate(status.lastScanned)}</span>
              </div>
            )}

            {status.status === 'unscanned' && (
              <div className="tooltip-hint">
                Click to scan this torrent
              </div>
            )}

            {status.status === 'error' && (
              <div className="tooltip-hint error">
                Scan failed - try again
              </div>
            )}
          </div>

          {(status.status === 'suspicious' || status.status === 'dangerous') && (
            <div className="tooltip-footer">
              <Icon name="info" size={12} />
              <span>Click for detailed report</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
