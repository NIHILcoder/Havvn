import { ErrorMessage } from './ErrorMessage';
/**
 * Input Component
 */

import React, { useId } from 'react';

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
  const generatedId = useId();
  const inputId = id || `input-${generatedId}`, hintId = `${inputId}-hint`;
  
  return (
    <div className="form-group input-field">
      {label && (
        <label htmlFor={inputId} className="label">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`input ${error ? 'input-error' : ''} ${className}`}
        {...props}
        aria-invalid={props['aria-invalid'] ?? (!!error || undefined)}
        aria-describedby={[props['aria-describedby'], error || helpText ? hintId : undefined].filter(Boolean).join(' ') || undefined}
      />
      {error ? (
        <span id={hintId} className="help-text" style={{ color: 'var(--color-error)' }}>
          <ErrorMessage error={error} />
        </span>
      ) : helpText ? (
        <span id={hintId} className="help-text">{helpText}</span>
      ) : null}
    </div>
  );
};

export default Input;
