/**
 * WindowControls — the app's minimise / maximise / close cluster, on its own.
 *
 * Lifted out of TitleBar so the SECOND frameless window in the app (a torn-off
 * dock group, DockWindowHost) wears the same three buttons rather than a lookalike
 * pair drawn twice. Everything that makes them look like Havvn's chrome — the
 * 46px × `--titlebar-h` hit boxes, the hover wash, the red close, the focus ring —
 * stays defined ONCE, in `.tb-ctrl` / `.tb-close` (renderer/styles/layout.css), so
 * the two bars cannot drift in height, colour or glyph weight.
 *
 * PRESENTATIONAL ONLY, and deliberately so:
 *  - no `window.api`, so each caller can address the window IT owns. The main
 *    title bar drives `win:minimize` (the room window); a dock window's bar drives
 *    `win:popoutMinimize` BY FRAME NAME, because a pop-out's React tree lives in
 *    the main renderer's realm and a sender-derived lookup in main would minimise
 *    the wrong window entirely;
 *  - no `t()`, so it is renderable from the dock's node harness (renderToStaticMarkup,
 *    no jsdom, no I18nProvider). Labels arrive already translated.
 *
 * macOS: `titleBarStyle: 'hiddenInset'` keeps the native traffic lights, so this
 * renders NOTHING there and the bar just reserves room for them on the left
 * (`.titlebar--mac`). Same rule for both windows — main.ts gives the dock pool the
 * identical platform treatment as the main window.
 */
import React from 'react';

/**
 * macOS keeps its native traffic lights, so we never draw our own there.
 *
 * Evaluated once at module load and guarded for a DOM-less realm: the dock's test
 * harness imports this file transitively and nothing in this folder may dereference
 * a global at import time.
 */
export const IS_MAC = typeof navigator !== 'undefined'
  && /Mac/i.test(navigator.platform || navigator.userAgent || '');

/** Already-translated accessible names. `restore` is the maximised state's label. */
export interface WindowControlLabels {
  minimize: string;
  maximize: string;
  restore: string;
  close: string;
}

/**
 * English last resort, for a caller with no dictionary in reach. Every caller in
 * the app passes translated labels; this only keeps a control from being announced
 * as an empty button if one ever forgets.
 */
export const DEFAULT_WINDOW_CONTROL_LABELS: WindowControlLabels = {
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
};

export interface WindowControlsProps {
  /** Drives the maximise/restore glyph AND its label. */
  maximized: boolean;
  labels?: WindowControlLabels;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export const WindowControls: React.FC<WindowControlsProps> = ({
  maximized,
  labels = DEFAULT_WINDOW_CONTROL_LABELS,
  onMinimize,
  onToggleMaximize,
  onClose,
}) => {
  if (IS_MAC) return null;
  const maxLabel = maximized ? labels.restore : labels.maximize;
  return (
    // `no-drag` is not decoration: `-webkit-app-region` inherits, and a control
    // inside a drag region is unclickable — it moves the window instead.
    <div className="titlebar-controls">
      <button type="button" className="tb-ctrl" onClick={onMinimize} aria-label={labels.minimize} title={labels.minimize}>
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="1" y="5" width="9" height="1" fill="currentColor" /></svg>
      </button>
      <button type="button" className="tb-ctrl" onClick={onToggleMaximize} aria-label={maxLabel} title={maxLabel}>
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><rect x="1.5" y="3.5" width="6" height="6" /><path d="M3.5 3.5V1.5h6v6h-2" /></svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><rect x="1.5" y="1.5" width="8" height="8" /></svg>
        )}
      </button>
      <button type="button" className="tb-ctrl tb-close" onClick={onClose} aria-label={labels.close} title={labels.close}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M1.5 1.5l8 8M9.5 1.5l-8 8" /></svg>
      </button>
    </div>
  );
};

export default WindowControls;
