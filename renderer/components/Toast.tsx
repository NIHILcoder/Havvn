/**
 * Toast Component
 * 
 * Notification toasts that appear in the top-right corner.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../utils/i18nContext';
import { Icon } from './Icon';
import { ErrorMessage } from './ErrorMessage';
import './Toast.css';
import { RecoveryError, type ErrorRecoveryContext } from './RecoveryError';

export interface ToastProps {
  id: string;
  message: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  onClose: (id: string) => void;
  recovery?: ErrorRecoveryContext;
}

export const Toast: React.FC<ToastProps> = ({
  id,
  message,
  variant = 'info',
  duration = 5000,
  onClose,
  recovery,
}) => {
  const { t } = useTranslation();
  const [isExiting, setIsExiting] = useState(false);
  const handleClose = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => { onClose(id); }, 300);
  }, [onClose, id]);

  useEffect(() => {
    if (duration > 0 && !recovery) {
      const timer = setTimeout(() => {
        handleClose();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [duration, recovery, handleClose]);

  const getIcon = () => {
    switch (variant) {
      case 'success':
        return 'check-circle';
      case 'error':
        return 'alert-circle';
      case 'warning':
        return 'alert-triangle';
      default:
        return 'info';
    }
  };

  return (
    <div className={`toast toast-${variant} ${isExiting ? 'toast-exit' : ''}`}>
      <div className="toast-icon">
        <Icon name={getIcon()} size={18} />
      </div>
      <div className="toast-message">{recovery ? <RecoveryError error={message} context={recovery} /> : variant === 'error' ? <ErrorMessage error={message} details /> : message}</div>
      <button type="button" className="toast-close" onClick={handleClose} aria-label={t('common.close')}>
        <Icon name="x" size={16} />
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: Array<{
    id: string;
    message: string;
    variant?: 'success' | 'error' | 'warning' | 'info';
    duration?: number;
    recovery?: ErrorRecoveryContext;
  }>;
  onClose: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onClose }) => {
  return (
    <div className="toast-container" aria-live="polite" aria-relevant="additions text">
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} onClose={onClose} />
      ))}
    </div>
  );
};
