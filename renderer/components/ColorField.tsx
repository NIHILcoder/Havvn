/**
 * ColorField — the theme editor's smart color control.
 *
 * A swatch (quick native picker) + the raw value text box (with the red-outline
 * validity hint) + an optional screen eyedropper + an optional "apply to both
 * variants" link + expandable H/S/L/A sliders. It never bypasses the sanitizer:
 * every value it emits is a plain string the editor still runs through
 * sanitizeTokenValue before it can be applied or saved.
 *
 * The sliders keep local HSLA state so dragging is smooth (round-tripping the
 * emitted value back through rgb would quantize the hue on low-saturation
 * colors). That state re-seeds only when the value changes from OUTSIDE this
 * field — a variant switch, accent derivation, apply-both, or typing.
 */
import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { parseColor, rgbToHsl, hslToRgb, toHex, toRgbString, toTriplet, Hsla, Rgba } from '../../shared/color';

interface EyeDropperResult { sRGBHex: string; }
interface EyeDropperInstance { open(): Promise<EyeDropperResult>; }
interface EyeDropperCtor { new (): EyeDropperInstance; }
const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

export interface ColorFieldProps {
  label: React.ReactNode;
  value: string;
  valid: boolean;
  /** 'triplet' for `--*-rgb` tokens (emit "r, g, b"); 'auto' emits hex / rgba(). */
  format?: 'auto' | 'triplet';
  onChange: (value: string) => void;
  /** When present, renders a link that copies the current value into both variants. */
  onApplyBoth?: (value: string) => void;
  /** When present (token is overridden), renders a reset-to-default control. */
  onReset?: () => void;
  applyBothTitle?: string;
  eyedropperTitle?: string;
  resetTitle?: string;
  sliderTitles?: { h: string; s: string; l: string; a: string };
}

const GRAY: Hsla = { h: 0, s: 0, l: 50, a: 1 };

export const ColorField: React.FC<ColorFieldProps> = ({
  label, value, valid, format = 'auto', onChange, onApplyBoth, onReset, applyBothTitle, eyedropperTitle, resetTitle, sliderTitles,
}) => {
  const [open, setOpen] = useState(false);
  const [hsla, setHsla] = useState<Hsla>(() => { const p = parseColor(value); return p ? rgbToHsl(p) : GRAY; });
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const p = parseColor(value);
    if (p) setHsla(rgbToHsl(p));
  }, [value]);

  const format2 = (rgba: Rgba): string =>
    format === 'triplet' ? toTriplet(rgba) : (rgba.a < 1 ? toRgbString(rgba) : toHex(rgba));

  // Slider edits go through HSL (that's what a slider adjusts).
  const emitHsla = (next: Hsla) => {
    setHsla(next);
    const out = format2(hslToRgb(next));
    lastEmitted.current = out;
    onChange(out);
  };

  // Swatch / eyedropper picks are an EXACT rgb — emit it directly (don't round-
  // trip through integer HSL, which would drift the picked color by a step).
  const emitRgba = (rgba: Rgba) => {
    setHsla(rgbToHsl(rgba));
    const out = format2(rgba);
    lastEmitted.current = out;
    onChange(out);
  };

  const swatchHex = toHex(hslToRgb({ ...hsla, a: 1 }));
  const fromHex = (hex: string) => { const p = parseColor(hex); if (p) emitRgba({ ...p, a: hsla.a }); };

  const pickScreen = () => {
    try {
      const ed = new (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper();
      ed.open().then((r) => fromHex(r.sRGBHex)).catch(() => { /* cancelled */ });
    } catch { /* unsupported */ }
  };

  const ariaLabel = typeof label === 'string' ? label : undefined;
  const st = sliderTitles ?? { h: 'H', s: 'S', l: 'L', a: 'A' };

  return (
    <div className="cf">
      <div className="cf-row">
        <input type="color" className="accent-swatch cf-swatch" value={swatchHex}
          onChange={(e) => fromHex(e.target.value)} aria-label={ariaLabel} />
        <span className="cf-label">{label}</span>
        <input type="text" className={`te-token-text cf-text ${valid ? '' : 'te-invalid'}`}
          value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        {hasEyeDropper && (
          <button type="button" className="cf-icon" onClick={pickScreen} title={eyedropperTitle} aria-label={eyedropperTitle}>
            <Icon name="pipette" size={14} />
          </button>
        )}
        {onApplyBoth && (
          <button type="button" className="cf-icon" onClick={() => onApplyBoth(value)} title={applyBothTitle} aria-label={applyBothTitle}>
            <Icon name="copy" size={14} />
          </button>
        )}
        {onReset && (
          <button type="button" className="cf-icon" onClick={onReset} title={resetTitle} aria-label={resetTitle}>
            <Icon name="rotate-ccw" size={14} />
          </button>
        )}
        <button type="button" className={`cf-icon cf-caret ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}
          aria-expanded={open} aria-label="HSL">
          <Icon name="chevron-down" size={14} />
        </button>
      </div>
      {open && (
        <div className="cf-sliders">
          <label className="cf-slider"><span>{st.h}</span>
            {/* max 359, not 360 — h=360 is identical to h=0 but would leave the
                thumb pinned right until the next reseed snapped it back to 0. */}
            <input type="range" min={0} max={359} value={hsla.h >= 360 ? 0 : hsla.h} onChange={(e) => emitHsla({ ...hsla, h: Number(e.target.value) })} />
            <span className="cf-slider-val">{hsla.h >= 360 ? 0 : hsla.h}</span></label>
          <label className="cf-slider"><span>{st.s}</span>
            <input type="range" min={0} max={100} value={hsla.s} onChange={(e) => emitHsla({ ...hsla, s: Number(e.target.value) })} />
            <span className="cf-slider-val">{hsla.s}</span></label>
          <label className="cf-slider"><span>{st.l}</span>
            <input type="range" min={0} max={100} value={hsla.l} onChange={(e) => emitHsla({ ...hsla, l: Number(e.target.value) })} />
            <span className="cf-slider-val">{hsla.l}</span></label>
          {format !== 'triplet' && (
            <label className="cf-slider"><span>{st.a}</span>
              <input type="range" min={0} max={100} value={Math.round(hsla.a * 100)} onChange={(e) => emitHsla({ ...hsla, a: Number(e.target.value) / 100 })} />
              <span className="cf-slider-val">{Math.round(hsla.a * 100)}</span></label>
          )}
        </div>
      )}
    </div>
  );
};

export default ColorField;
