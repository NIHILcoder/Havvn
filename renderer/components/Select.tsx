import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { Icon } from './Icon';
import { useFieldLabel } from '../utils/fieldLabel';
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
  const field = useFieldLabel();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const search = useRef({ text: '', at: 0 });
  const selectRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const active = Math.min(activeIndex, options.length - 1);
  const openMenu = () => { setActiveIndex(Math.max(0, options.findIndex(option => option.value === value))); setIsOpen(true); };

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
    const selected = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (list && selected) {
      if (selected.offsetTop < list.scrollTop) list.scrollTop = selected.offsetTop;
      else if (selected.offsetTop + selected.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = selected.offsetTop + selected.offsetHeight - list.clientHeight;
    }
  }, [isOpen, active]);

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
    search.current = { text: '', at: 0 };
    onChange(optionValue);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || e.nativeEvent.isComposing) return;
    
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isOpen && options[active]) handleSelect(options[active].value); else openMenu();
    } else if (e.key === 'Escape') {
      search.current = { text: '', at: 0 };
      if (isOpen) { e.preventDefault(); e.stopPropagation(); }
      setIsOpen(false);
    } else if (e.key === 'Tab') {
      if (isOpen && options[active]) onChange(options[active].value);
      setIsOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      if (!isOpen) {
        openMenu();
        return;
      }
      
      setActiveIndex(e.key === 'ArrowDown' ? (active + 1) % options.length : (active - 1 + options.length) % options.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); setIsOpen(true); setActiveIndex(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const now = Date.now();
      const query = (now - search.current.at < 700 ? search.current.text : '') + e.key.toLocaleLowerCase();
      search.current = { text: query, at: now };
      const match = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(query));
      if (match >= 0) { e.preventDefault(); setActiveIndex(match); setIsOpen(true); }
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
        onBlur={event => { if (!selectRef.current?.contains(event.relatedTarget as Node | null)) setIsOpen(false); }}
        tabIndex={disabled ? -1 : 0}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen && options[active] ? `${listId}-${active}` : undefined}
        aria-disabled={disabled}
        aria-label={ariaLabel ?? (field ? undefined : placeholder ?? t('select.placeholder'))}
        aria-labelledby={ariaLabel ? undefined : field?.labelId}
        aria-describedby={ariaDescribedBy ?? field?.descriptionId}
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
          <ul id={listId} role="listbox" aria-label={ariaLabel ?? (field ? undefined : placeholder ?? t('select.placeholder'))} aria-labelledby={ariaLabel ? undefined : field?.labelId} className="custom-select-list">
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                data-active={index === active}
                className={`custom-select-option ${option.value === value ? 'selected' : ''}`}
                // Keep focus on the combobox until click commits the option.
                // Native mousedown would otherwise blur the trigger and unmount
                // this list before mouseup/click can deliver the selection.
                onMouseDown={event => event.preventDefault()}
                onClick={() => handleSelect(option.value)}
                role="option"
                aria-selected={option.value === value}
              >
                {option.icon && <Icon name={option.icon as any} size={16} />}
                <span>{option.label}</span>
                {option.value === value && (
                  <span className="custom-select-check" aria-hidden="true" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
