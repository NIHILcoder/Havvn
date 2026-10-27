import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useTranslation } from '../utils/i18nContext';
import './VirtualFileList.css';

interface Props<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => React.Key;
  renderRow: (item: T, index: number) => React.ReactNode;
  className: string;
  label: string;
  estimateSize: number;
  gap?: number;
  resetKey?: string;
  empty?: React.ReactNode;
}

/** Keep the complete data model, but mount only the visible part of large lists. */
export function VirtualFileList<T>({ items, getKey, renderRow, className, label, estimateSize, gap = 0, resetKey, empty }: Props<T>) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const windowed = items.length > 100;
  const itemKey = useCallback((index: number) => getKey(items[index], index), [items, getKey]);
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled: windowed,
    getScrollElement: () => viewport.current,
    getItemKey: itemKey,
    estimateSize: () => estimateSize,
    gap,
    overscan: 4,
    // A focused checkbox/button must survive scrolling and live progress updates.
    rangeExtractor: useCallback((range: Range) => {
      const visible = defaultRangeExtractor(range);
      return focused !== null && focused < items.length && !visible.includes(focused)
        ? [...visible, focused].sort((a, b) => a - b) : visible;
    }, [focused, items.length]),
  });
  useLayoutEffect(() => {
    viewport.current?.scrollTo({ top: 0 });
    setFocused(null);
  }, [resetKey]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!windowed || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !items.length) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-file-row]');
    const current = row ? Number(row.dataset.fileRow) : (virtualizer.getVirtualItems()[0]?.index ?? 0);
    const page = Math.max(1, Math.floor((viewport.current?.clientHeight ?? 300) / estimateSize));
    const next = ({ ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: items.length - 1,
      PageDown: current + page, PageUp: current - page } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(items.length - 1, next));
    virtualizer.scrollToIndex(index, { align: 'auto' });
    const win = viewport.current?.ownerDocument.defaultView;
    win?.requestAnimationFrame(() => {
      const target = viewport.current?.querySelector<HTMLElement>(`[data-file-row="${index}"]`);
      (target?.querySelector<HTMLElement>('input:not(:disabled),button:not(:disabled),[href]') ?? target)?.focus({ preventScroll: true });
    });
  };
  const row = (index: number, style?: React.CSSProperties) => (
    <div key={itemKey(index)} className="vfl-row" role="listitem" aria-setsize={items.length} aria-posinset={index + 1}
      data-index={index} data-file-row={index} tabIndex={-1} style={style}
      ref={windowed ? virtualizer.measureElement : undefined}>
      {renderRow(items[index], index)}
    </div>
  );
  return <div ref={viewport} className={`${className} vfl${windowed ? ' vfl--windowed' : ''}`} role="list" aria-label={label}
    aria-description={windowed ? t('filePicker.keyboardNavigation') : undefined} tabIndex={windowed ? 0 : undefined}
    onKeyDown={onKeyDown}
    onFocusCapture={event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-file-row]');
      setFocused(target ? Number(target.dataset.fileRow) : null);
    }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null); }}>
    {!items.length ? empty : windowed ? <div className="vfl-space" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => row(item.index, { position: 'absolute', top: 0, left: 0,
        width: '100%', transform: `translateY(${item.start}px)` }))}
    </div> : items.map((_, index) => row(index))}
  </div>;
}
