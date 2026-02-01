/**
 * Button Component
 */

import React from 'react';

type ButtonVariant = 'default' | 'primary' | 'secondary' | 'danger' | 'ghost' | 'warning';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconOnly?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'default',
  size = 'md',
  loading = false,
  icon,
  iconOnly = false,
  children,
  className = '',
  disabled,
  ...props
}) => {
  const variantClass = variant !== 'default' ? `btn-${variant}` : '';
  const sizeClass = size !== 'md' ? `btn-${size}` : '';
  const iconOnlyClass = iconOnly ? 'btn-icon' : '';
  
  const classes = ['btn', variantClass, sizeClass, iconOnlyClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="spinner spinner-sm" />
      ) : icon ? (
        <>
          {icon}
          {!iconOnly && children}
        </>
      ) : (
        children
      )}
    </button>
  );
};

export default Button;
