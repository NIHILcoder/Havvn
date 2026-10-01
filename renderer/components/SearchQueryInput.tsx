import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { useTranslation } from '../utils/i18nContext';
import './SearchQueryInput.css';

interface SearchQueryInputProps {
  value: string;
  onChange: (value: string) => void;
  history: string[];
}

/** Theme-aware query completion; the native datalist popup cannot be styled. */
export const SearchQueryInput: React.FC<SearchQueryInputProps> = ({ value, onChange, history }) => {
  const { t } = useTranslation();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<React.CSSProperties | null>(null);
  const suggestions = useMemo(() => {
    const term = value.trim().toLowerCase();
    return [...new Set(history)].filter(item => item.trim() && (showAll || item.toLowerCase().includes(term))).slice(0, 10);
  }, [history, value, showAll]);
  const expanded = open && suggestions.length > 0;
  const activeOption = active >= 0 && active < suggestions.length ? active : -1;

  const close = () => { setOpen(false); setActive(-1); };
  const choose = (item: string) => {
    onChange(item);
    inputRef.current?.focus();
    close();
  };

  useLayoutEffect(() => {
    if (!expanded || !wrapperRef.current) { setPosition(null); return; }
    const wrapper = wrapperRef.current;
    const win = wrapper.ownerDocument.defaultView;
    if (!win) return;
    const place = () => {
      const rect = wrapper.getBoundingClientRect();
      const below = Math.max(0, win.innerHeight - rect.bottom - 14);
      const above = Math.max(0, rect.top - 14);
      const desiredHeight = Math.min(280, 38 + suggestions.length * 38);
      const upward = below < desiredHeight && above > below;
      const height = Math.min(desiredHeight, upward ? above : below);
      const width = Math.min(rect.width, Math.max(0, win.innerWidth - 16));
      setPosition({
        top: upward ? rect.top - height - 6 : rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, win.innerWidth - width - 8)),
        width, maxHeight: height,
      });
    };
    place();
    win.addEventListener('resize', place);
    return () => win.removeEventListener('resize', place);
  }, [expanded, suggestions.length]);

  useEffect(() => {
    if (!expanded || !wrapperRef.current) return;
    const doc = wrapperRef.current.ownerDocument;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false); setActive(-1);
      }
    };
    const scroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) { setOpen(false); setActive(-1); }
    };
    doc.addEventListener('pointerdown', outside);
    doc.addEventListener('scroll', scroll, true);
    return () => { doc.removeEventListener('pointerdown', outside); doc.removeEventListener('scroll', scroll, true); };
  }, [expanded]);

  useEffect(() => {
    if (expanded && activeOption >= 0) menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [expanded, activeOption]);

  useEffect(() => {
    const form = inputRef.current?.form;
    const dismiss = () => { setOpen(false); setActive(-1); };
    form?.addEventListener('submit', dismiss);
    return () => form?.removeEventListener('submit', dismiss);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
      event.preventDefault();
      setOpen(true);
      setActive(previous => {
        if (!expanded || previous < 0) return event.key === 'ArrowDown' ? 0 : suggestions.length - 1;
        return (previous + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      });
    } else if (event.key === 'Enter') {
      if (expanded && activeOption >= 0) {
        event.preventDefault();
        choose(suggestions[activeOption]);
      } else close(); // The form submits the typed query normally.
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Tab') close();
  };

  const doc = inputRef.current?.ownerDocument;
  return <div className={`search-input-wrap search-query-input${history.length ? ' has-history' : ''}`} ref={wrapperRef}>
    <Icon name="search" size={18} className="search-icon-inside" />
    <input ref={inputRef} type="text" className="search-input" placeholder={t('search.input')}
      aria-label={t('search.input')} value={value} autoFocus autoComplete="off" spellCheck={false}
      role="combobox" aria-autocomplete="list" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && activeOption >= 0 ? `${listId}-${activeOption}` : undefined}
      onChange={event => { onChange(event.target.value); setShowAll(false); setActive(-1); setOpen(true); }}
      onFocus={() => { if (value.trim()) setOpen(true); }} onBlur={close} onKeyDown={onKeyDown}
    />
    {history.length > 0 && <button type="button" className={`query-history-toggle${expanded ? ' open' : ''}`}
      aria-label={t('search.queryHistory.label')} aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      tabIndex={-1} onMouseDown={event => event.preventDefault()}
      onClick={() => { inputRef.current?.focus(); setShowAll(true); setActive(-1); setOpen(!expanded); }}
    ><Icon name="chevron-down" size={16} /></button>}
    {expanded && position && doc && createPortal(
      <div className="query-history-menu" style={position} ref={menuRef}>
        <div className="query-history-heading"><Icon name="clock" size={13} />{t('search.queryHistory.label')}</div>
        <div id={listId} role="listbox" aria-label={t('search.queryHistory.label')} className="query-history-list">
          {suggestions.map((item, index) => <button type="button" role="option" key={item}
            id={`${listId}-${index}`} aria-selected={index === activeOption} tabIndex={-1}
            className={`query-history-option${index === activeOption ? ' active' : ''}`} title={item}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}
          ><Icon name="search" size={14} /><span>{item}</span></button>)}
        </div>
      </div>, doc.body,
    )}
  </div>;
};
