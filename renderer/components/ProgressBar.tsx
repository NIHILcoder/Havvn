/**
 * ProgressBar Component
 */

import React from 'react';

interface ProgressBarProps {
  value: number; // 0-1 or 0-100
  max?: number;
  variant?: 'default' | 'success' | 'warning' | 'error';
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 1,
  variant = 'default',
  showLabel = false,
  size = 'md',
  className = '',
}) => {
  // Normalize to percentage
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  
  const heightMap = {
    sm: '4px',
    md: '6px',
    lg: '10px',
  };

  return (
    <div className={`progress-wrapper ${className}`} style={{ position: 'relative' }}>
      <div 
        className="progress" 
        style={{ height: heightMap[size] }}
      >
        <div
          className={`progress-bar ${variant !== 'default' ? variant : ''}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <span 
          className="progress-label"
          style={{
            position: 'absolute',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-secondary)',
            marginLeft: 'var(--space-2)',
          }}
        >
          {percentage.toFixed(1)}%
        </span>
      )}
    </div>
  );
};

export default ProgressBar;
