/**
 * ProgressBar Component
 */

import React from 'react';

interface ProgressBarProps {
  value: number | null; // Null = unmeasured, never an artificial 0%.
  max?: number;
  variant?: 'default' | 'success' | 'warning' | 'error';
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 1,
  variant = 'default',
  showLabel = false,
  size = 'md',
  className = '',
  label,
}) => {
  // Normalize to percentage
  const percentage = value !== null && Number.isFinite(value) && Number.isFinite(max) && max > 0
    ? Math.min(100, Math.max(0, (value / max) * 100)) : null;
  
  const heightMap = {
    sm: '4px',
    md: '6px',
    lg: '10px',
  };

  return (
    <div className={`progress-wrapper ${className}`} style={{ position: 'relative' }}>
      <div
        className={`progress-bar${percentage === null ? ' progress-bar-indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage ?? undefined}
        style={{ height: heightMap[size] }}
      >
        <div
          className={`progress-bar-fill ${variant !== 'default' ? variant : ''}`}
          style={{ width: percentage === null ? '100%' : `${percentage}%` }}
        />
      </div>
      {showLabel && percentage !== null && (
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
