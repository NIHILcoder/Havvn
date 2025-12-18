/**
 * Alert Component
 */

import React from 'react';
import Icon, { IconName } from './Icon';

type AlertVariant = 'success' | 'warning' | 'error' | 'info';

interface AlertProps {
  variant: AlertVariant;
  children: React.ReactNode;
  onClose?: () => void;
  className?: string;
}

const iconMap: Record<AlertVariant, IconName> = {
  success: 'check',
  warning: 'alert-circle',
  error: 'alert-circle',
  info: 'info',
};

export const Alert: React.FC<AlertProps> = ({
  variant,
  children,
  onClose,
  className = '',
}) => {
  return (
    <div className={`alert alert-${variant} ${className}`}>
      <Icon name={iconMap[variant]} size={18} />
      <div style={{ flex: 1 }}>{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          className="btn btn-ghost btn-icon btn-sm"
          style={{ marginLeft: 'auto' }}
        >
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
};

export default Alert;
