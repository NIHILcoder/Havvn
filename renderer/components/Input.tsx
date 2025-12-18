/**
 * Input Component
 */

import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helpText?: string;
  error?: string;
}

export const Input: React.FC<InputProps> = ({
  label,
  helpText,
  error,
  className = '',
  id,
  ...props
}) => {
  const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;
  
  return (
    <div className="form-group">
      {label && (
        <label htmlFor={inputId} className="label">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`input ${error ? 'input-error' : ''} ${className}`}
        {...props}
      />
      {error ? (
        <span className="help-text" style={{ color: 'var(--color-error)' }}>
          {error}
        </span>
      ) : helpText ? (
        <span className="help-text">{helpText}</span>
      ) : null}
    </div>
  );
};

export default Input;
