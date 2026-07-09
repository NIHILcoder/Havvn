/**
 * EmptyState Component
 */

import React from 'react';
import Icon, { IconName } from './Icon';
import Button from './Button';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: IconName;
}

interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  /** Optional second (ghost) action shown next to the primary one. */
  secondaryAction?: EmptyStateAction;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'package',
  title,
  description,
  action,
  secondaryAction,
  className = '',
}) => {
  return (
    <div className={`empty-state ${className}`}>
      <div className="empty-state-icon">
        <Icon name={icon} size={48} />
      </div>
      <h3 className="empty-state-title">{title}</h3>
      {description && (
        <p className="empty-state-description">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="empty-state-actions">
          {action && (
            <Button variant="primary" onClick={action.onClick} icon={action.icon ? <Icon name={action.icon} size={16} /> : undefined}>
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button variant="ghost" onClick={secondaryAction.onClick} icon={secondaryAction.icon ? <Icon name={secondaryAction.icon} size={16} /> : undefined}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
