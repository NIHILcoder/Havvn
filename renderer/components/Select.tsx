import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import './Select.css';

export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
}

export const Select: React.FC<SelectProps> = ({
  options,
  value,
  onChange,
  placeholder,
  className = '',
  disabled = false,
  id,
  ariaLabel,
  ariaDescribedBy,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const openMenu = () => setIsOpen(true);

  const positionMenu = useCallback(() => {
    const el = selectRef.current, menu = menuRef.current;
    if (!el || !menu) return;
    const win = el.ownerDocument.defaultView ?? window;
    const r = el.getBoundingClientRect(), gap = 6, edge = 8;
    const below = win.innerHeight - r.bottom - gap - edge, above = r.top - gap - edge;
    const list = menu.querySelector<HTMLElement>('.custom-select-list');
    const up = below < Math.min(list?.scrollHeight ?? menu.scrollHeight, 250) + 2 && above > below;
    const available = Math.max(0, up ? above : below);
    menu.style.width = `${Math.min(r.width, Math.max(0, win.innerWidth - edge * 2))}px`;
    menu.style.setProperty('--select-list-max-height', `${Math.max(0, Math.min(250, available - 2))}px`);
    menu.style.left = `${Math.max(edge, Math.min(r.left, win.innerWidth - menu.offsetWidth - edge))}px`;
    menu.style.top = `${Math.max(edge, up ? r.top - gap - menu.offsetHeight : r.bottom + gap)}px`;
    menu.classList.toggle('drop-up', up);
  }, []);

  // The top layer escapes dialog/scroll clipping while retaining the owning
  // document, theme inheritance and modal focus trap (unlike a body portal).
  useLayoutEffect(() => {
    const menu = menuRef.current, el = selectRef.current;
    if (!isOpen || !menu || !el) return;
    menu.setAttribute('popover', 'manual');
    menu.showPopover(); positionMenu();
    const win = el.ownerDocument.defaultView ?? window, doc = el.ownerDocument;
    const observer = new (win as Window & typeof globalThis).ResizeObserver(positionMenu);
    observer.observe(el);
    const onScroll = (e: Event) => { if (!menu.contains(e.target as Node)) setIsOpen(false); };
    win.addEventListener('resize', positionMenu);
    doc.addEventListener('scroll', onScroll, true);
    return () => {
      observer.disconnect(); win.removeEventListener('resize', positionMenu);
      doc.removeEventListener('scroll', onScroll, true);
      if (menu.matches(':popover-open')) menu.hidePopover();
    };
  }, [isOpen, positionMenu]);

  useLayoutEffect(() => { if (isOpen) positionMenu(); });
  useLayoutEffect(() => {
    if (!isOpen) return;
    const list = menuRef.current?.querySelector<HTMLElement>('.custom-select-list');
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && selected) {
      if (selected.offsetTop < list.scrollTop) list.scrollTop = selected.offsetTop;
      else if (selected.offsetTop + selected.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = selected.offsetTop + selected.offsetHeight - list.clientHeight;
    }
  }, [isOpen, value]);

  useEffect(() => { if (disabled) setIsOpen(false); }, [disabled]);

  // Handle outside click to close dropdown. Listen on the select's OWN document —
  // inside a pop-out window, main-document listeners never see its events.
  useEffect(() => {
    const doc = selectRef.current?.ownerDocument ?? document;
    const handleClickOutside = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      doc.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      doc.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isOpen) setIsOpen(false); else openMenu();
    } else if (e.key === 'Escape') {
      if (isOpen) { e.preventDefault(); e.stopPropagation(); }
      setIsOpen(false);
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      if (!isOpen) {
        openMenu();
        return;
      }
      
      const currentIndex = options.findIndex((opt) => opt.value === value);
      let nextIndex = currentIndex;
      
      if (e.key === 'ArrowDown') {
        nextIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
      }
      
      onChange(options[nextIndex].value);
    }
  };

  return (
    <div 
      className={`custom-select-container ${className} ${disabled ? 'disabled' : ''}`} 
      ref={selectRef}
    >
      <button
        id={id}
        type="button"
        disabled={disabled}
        className={`custom-select-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => { if (!disabled) { if (isOpen) setIsOpen(false); else openMenu(); } }}
        onKeyDown={handleKeyDown}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
      >
        <span className="custom-select-value">
          {selectedOption ? (
            <>
              {selectedOption.icon && <Icon name={selectedOption.icon as any} size={16} />}
              <span>{selectedOption.label}</span>
            </>
          ) : (
            <span className="placeholder">{placeholder ?? t('select.placeholder')}</span>
          )}
        </span>
        <span className="custom-select-icon">
          <Icon name="chevron-down" size={16} />
        </span>
      </button>

      {isOpen && (
        <div ref={menuRef} className="custom-select-dropdown">
          <ul role="listbox" className="custom-select-list">
            {options.map((option) => (
              <li
                key={option.value}
                className={`custom-select-option ${option.value === value ? 'selected' : ''}`}
                onClick={() => handleSelect(option.value)}
                role="option"
                aria-selected={option.value === value}
              >
                {option.icon && <Icon name={option.icon as any} size={16} />}
                <span>{option.label}</span>
                {option.value === value && (
                  <div className="custom-select-check">
                    <Icon name="check" size={14} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
