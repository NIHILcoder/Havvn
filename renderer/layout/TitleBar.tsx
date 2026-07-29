/**
 * Custom HUD title bar for the frameless window (main.ts sets frame:false on
 * Win/Linux, hiddenInset on macOS). Draws the brand lockup on a draggable bar and
 * drives minimize/maximize/close over IPC — replacing the OS caption so the app
 * owns its whole chrome (no accent-coloured native frame).
 *
 * The three control buttons themselves live in WindowControls.tsx, because a
 * torn-off dock window (DockWindowHost) is frameless too and must wear the SAME
 * chrome. This file keeps what is specific to the app window: the brand lockup and
 * the IPC that drives the MAIN window (`win:minimize` & co). A dock window's bar
 * drives the pop-out channels instead, addressed by frame name.
 */
import React, { useEffect, useState } from 'react';
import { LogoMark, Wordmark } from '../components';
import { WindowControls, IS_MAC } from './WindowControls';
import { useTranslation } from '../utils/i18nContext';

export const TitleBar: React.FC = () => {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = window.api?.win;
    if (!w) return;
    w.isMaximized().then(setMaximized).catch(() => { /* ignore */ });
    return w.onMaximizeChange(setMaximized);
  }, []);

  const w = window.api?.win;

  return (
    <div className={`titlebar${IS_MAC ? ' titlebar--mac' : ''}`}>
      <div className="titlebar-brand" aria-hidden="true">
        <LogoMark size={19} />
        <Wordmark height={12} className="titlebar-wm" />
      </div>
      {/* The flexible middle IS the drag handle; double-click toggles maximize. */}
      <div className="titlebar-drag" onDoubleClick={() => w?.toggleMaximize()} />
      <WindowControls
        maximized={maximized}
        labels={{
          minimize: t('window.minimize'),
          maximize: t('window.maximize'),
          restore: t('window.restore'),
          close: t('window.close'),
        }}
        onMinimize={() => w?.minimize()}
        onToggleMaximize={() => w?.toggleMaximize()}
        onClose={() => w?.close()}
      />
    </div>
  );
};
