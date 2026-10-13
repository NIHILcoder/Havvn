import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RoomState } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../utils/format-helpers';
import { useTranslation } from '../../utils/i18nContext';
import { useAnchoredOverlayDismiss } from '../../utils/useAnchoredOverlayDismiss';
import './RoomFileBudgetInfo.css';

export function RoomFileBudgetInfo({ resources }: { resources: NonNullable<RoomState['resources']> }) {
  const { t } = useTranslation();
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const timer = useRef<{ win: Window; id: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const cancelTimer = useCallback(() => {
    if (timer.current) timer.current.win.clearTimeout(timer.current.id);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelTimer();
    setOpen(false);
    setPinned(false);
  }, [cancelTimer]);
  const preview = () => { cancelTimer(); setOpen(true); };
  const leave = () => {
    cancelTimer();
    const win = button.current?.ownerDocument.defaultView;
    if (!pinned && win) timer.current = { win, id: win.setTimeout(close, 150) };
  };
  useEffect(() => cancelTimer, [cancelTimer]);
  useAnchoredOverlayDismiss(button.current, overlay, open, close);

  const position = useCallback(() => {
    const anchor = button.current, pop = overlay.current;
    const win = anchor?.ownerDocument.defaultView;
    if (!anchor || !pop || !win) return;
    const rect = anchor.getBoundingClientRect(), edge = 8, gap = 6;
    pop.style.width = `${Math.min(320, Math.max(0, win.innerWidth - edge * 2))}px`;
    pop.style.maxHeight = `${Math.max(0, win.innerHeight - edge * 2)}px`;
    pop.style.left = `${Math.max(edge, Math.min(rect.left, win.innerWidth - pop.offsetWidth - edge))}px`;
    const top = rect.bottom + gap + pop.offsetHeight <= win.innerHeight - edge
      ? rect.bottom + gap : rect.top - gap - pop.offsetHeight;
    pop.style.top = `${Math.max(edge, Math.min(top, win.innerHeight - pop.offsetHeight - edge))}px`;
  }, []);

  useLayoutEffect(() => {
    const pop = overlay.current, anchor = button.current;
    if (!open || !pop || !anchor) return;
    pop.setAttribute('popover', 'manual');
    pop.showPopover();
    position();
    const win = anchor.ownerDocument.defaultView as Window & typeof globalThis;
    const observer = new win.ResizeObserver(position);
    observer.observe(anchor);
    observer.observe(pop);
    return () => { observer.disconnect(); if (pop.matches(':popover-open')) pop.hidePopover(); };
  }, [open, position]);
  useLayoutEffect(() => { if (open) position(); });

  useEffect(() => {
    const doc = button.current?.ownerDocument;
    if (!open || !doc) return;
    const outside = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    doc.addEventListener('mousedown', outside);
    doc.addEventListener('keydown', escape, true);
    return () => { doc.removeEventListener('mousedown', outside); doc.removeEventListener('keydown', escape, true); };
  }, [open, close]);

  const speed = (value: number) => value < 0 ? t('rooms.unlimited') : formatBytes(value) + '/s';
  return (
    <div className="room-file-budget" ref={wrap} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
      <button
        type="button" ref={button}
        className={'room-newfolder-btn icon-only' + (open ? ' active' : '')}
        aria-label={t('rooms.fileAllocation')} aria-expanded={open} aria-describedby={open ? id : undefined}
        onMouseEnter={preview} onMouseLeave={leave} onFocus={preview}
        onClick={() => { cancelTimer(); if (pinned) close(); else { setPinned(true); setOpen(true); } }}
      >
        <Icon name="gauge" size={14} />
      </button>
      {open && (
        <div className="room-file-budget-popover" id={id} ref={overlay} role="tooltip" onMouseEnter={cancelTimer} onMouseLeave={leave}>
          <strong>{t('rooms.fileAllocation')}</strong>
          <div className="room-file-budget-speed"><span><Icon name="arrow-down" size={13} />{t('speedGraph.download')}</span><b>{speed(resources.fileDownBps)}</b></div>
          <div className="room-file-budget-speed"><span><Icon name="arrow-up" size={13} />{t('speedGraph.upload')}</span><b>{speed(resources.fileUpBps)}</b></div>
          {resources.voicePriorityActive && <div className="room-file-budget-priority"><Icon name="mic" size={13} />{t('rooms.voicePriorityActive')}</div>}
          <p>{t('rooms.fileAllocationHint')}</p>
        </div>
      )}
    </div>
  );
}
