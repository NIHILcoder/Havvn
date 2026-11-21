import React, { useEffect, useMemo, useState, useId, useRef } from 'react';
import { BODY_TEXT_CONTRAST, inspectReadability, proposeReadableColors, type ColorTokens } from '../../shared/theme-readability';
import { parseColor, toRgbString } from '../../shared/color';
import { useTranslation } from '../utils/i18nContext';
import Button from './Button';

const safe = (value: string) => { const color = parseColor(value); return color ? toRgbString(color) : undefined; };
export function ThemeReadability({ tokens, onApply }: { tokens: ColorTokens; onApply: (patch: Record<string, string>) => void }) {
  const { t } = useTranslation();
  const rows = useMemo(() => inspectReadability(tokens), [tokens]);
  const failed = rows.filter(row => row.ratio === null || row.ratio < BODY_TEXT_CONTRAST);
  const [preview, setPreview] = useState<ColorTokens | null>(null);
  const previewId = useId();
  const previewButton = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const message = failed.length ? t('a11y.contrast.warning').replace('{n}', String(failed.length)) : '';
  useEffect(() => { const timer = setTimeout(() => setAnnouncement(message), 700); return () => clearTimeout(timer); }, [message]);
  const patch = useMemo(() => preview === tokens ? proposeReadableColors(tokens) : null, [tokens, preview]);
  return <>
    <span className="sr-only" role="status" aria-atomic="true">{announcement}</span>
    {failed.length > 0 && <section className="te-readability" aria-label={t('a11y.contrast.title')}>
      <strong>{message}</strong><p>{t('a11y.contrast.hint')}</p>
      <button ref={previewButton} type="button" className="btn btn-secondary btn-sm" aria-expanded={!!patch} aria-controls={patch ? previewId : undefined} onClick={() => setPreview(patch ? null : tokens)}>{t('a11y.contrast.preview')}</button>
      {patch && <div id={previewId}>
        <div className="te-readability-samples">
          {failed.map(row => <div className="te-readability-pair" key={row.fg + row.bg}>
            <small>{row.fg.replace('--color-', '')} / {row.bg.replace('--color-', '')}</small>
            <div className="te-readability-comparison" style={{ background: safe(tokens['--color-bg-primary']) }}>
              <span style={{ color: safe(tokens[row.fg]), background: safe(tokens[row.bg]) }}>{t('a11y.contrast.before')} · Aa</span>
              <span style={{ color: safe(patch[row.fg] ?? tokens[row.fg]), background: safe(tokens[row.bg]) }}>{t('a11y.contrast.after')} · Aa</span>
            </div>
          </div>)}
        </div>
        <p>{t('a11y.contrast.draftOnly')}</p>
        {inspectReadability({ ...tokens, ...patch }).some(row => row.ratio === null || row.ratio < BODY_TEXT_CONTRAST) && <p>{t('a11y.contrast.manual')}</p>}
        <div className="te-readability-actions"><Button size="sm" variant="primary" disabled={!Object.keys(patch).length} onClick={() => { onApply(patch); setPreview(null); }}>{t('a11y.contrast.apply')}</Button>
          <Button size="sm" variant="secondary" onClick={() => { setPreview(null); previewButton.current?.focus(); }}>{t('common.cancel')}</Button></div>
      </div>}
    </section>}
  </>;
}
