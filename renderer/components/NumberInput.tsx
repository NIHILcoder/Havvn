import React, { useRef } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import './NumberInput.css';

interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  onValueChange: (value: string) => void;
}

/** Retain native number validation/keyboard stepping, with themeable controls. */
export function NumberInput({ onValueChange, className = '', disabled, readOnly, ...props }: NumberInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  const step = (direction: number) => {
    const field = input.current;
    if (!field) return;
    if (direction > 0) field.stepUp(); else field.stepDown();
    onValueChange(field.value);
    field.focus();
  };
  return <span className="number-input">
    <input {...props} ref={input} type="number" className={className} disabled={disabled} readOnly={readOnly}
      onChange={event => onValueChange(event.target.value)} />
    <span className="number-input-controls">
      <button type="button" tabIndex={-1} disabled={disabled || readOnly} aria-label={t('common.increase')}
        title={t('common.increase')} onMouseDown={event => event.preventDefault()} onClick={() => step(1)}>
        <Icon name="chevron-up" size={10} />
      </button>
      <button type="button" tabIndex={-1} disabled={disabled || readOnly} aria-label={t('common.decrease')}
        title={t('common.decrease')} onMouseDown={event => event.preventDefault()} onClick={() => step(-1)}>
        <Icon name="chevron-down" size={10} />
      </button>
    </span>
  </span>;
}
