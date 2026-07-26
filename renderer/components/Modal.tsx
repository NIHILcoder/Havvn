/**
 * Modal — the one shared dialog shell for the whole app.
 *
 * Every dialog (rooms, share, create-torrent, previews, pickers, confirms) uses
 * this so they look identical and behave identically: an Ember graphite card on
 * a blurred backdrop, a header with an optional ember icon + title + close X, a
 * scrolling body, and an optional footer action row. Focus moves in on open,
 * Tab is trapped inside, focus is restored on close, and Escape / backdrop-click
 * dismiss (both suppressed while `busy`).
 *
 * Special surfaces that are NOT centered dialogs — the media players, the
 * right-click ContextMenu, anchored dropdowns — deliberately do NOT use this.
 */

import React, { useEffect, useRef } from 'react';
import Icon, { IconName } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import './Modal.css';

/** Escape-to-close, suppressible (e.g. while an async action is in flight). */
export function useEscape(onClose: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, active]);
}

// Stack of currently-open modals (innermost last). Escape closes only the
// topmost one, so a confirm/alert shown OVER another dialog doesn't dismiss the
// layer beneath it. Each Modal registers a token while mounted.
const modalStack: object[] = [];
function useModalEscape(token: object, onClose: () => void, active: boolean): void {
  useEffect(() => {
    modalStack.push(token);
    return () => { const i = modalStack.indexOf(token); if (i >= 0) modalStack.splice(i, 1); };
  }, [token]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [token, onClose, active]);
}

/** Move focus into the dialog on open, trap Tab inside it, restore focus on close. */
export function useModalFocus(): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    // Prefer the first field/control; fall back to the dialog itself.
    const initial = dialog?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [data-autofocus]',
    );
    (initial || dialog)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.offsetParent !== null); // skip display:none
      if (focusables.length === 0) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (active && !dialog.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (active === first || active === dialog)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);
  return ref;
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  onClose: () => void;
  /** Header title. Omit together with hideClose for a bare card (rare). */
  title?: React.ReactNode;
  /** Ember-tinted icon shown before the title. */
  icon?: IconName;
  /** sm 400 · md 480 · lg 620 · xl 780 · full 96vw (players/pickers). */
  size?: ModalSize;
  /** Footer action row (usually Buttons). Omitted → no footer. */
  footer?: React.ReactNode;
  /** Hide the header × (dialogs whose only dismissal is a footer button). */
  hideClose?: boolean;
  /** Lock dismissal (Escape + backdrop) while an async action runs. */
  busy?: boolean;
  /** Backdrop click closes (default true; ignored while busy). */
  closeOnBackdrop?: boolean;
  /** Extra class on the card (e.g. a bespoke width). */
  className?: string;
  /**
   * Extra class on the BACKDROP — the element that carries the z-index. Needed
   * because a Modal renders in place rather than portalling, so two open modals
   * at the same z-index are ordered by DOM position: one portalled to <body>
   * lands after (and therefore above) one rendered from a provider near the app
   * root. A dialog that must sit on top regardless (see ConfirmProvider) raises
   * its own layer here.
   */
  backdropClassName?: string;
  /** Extra class on the scrolling body. */
  bodyClassName?: string;
  /** aria-label when there is no visible title. */
  ariaLabel?: string;
  children?: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  onClose, title, icon, size = 'md', footer, hideClose = false, busy = false,
  closeOnBackdrop = true, className = '', backdropClassName = '', bodyClassName = '', ariaLabel, children,
}) => {
  const { t } = useTranslation();
  const ref = useModalFocus();
  const token = useRef({});
  useModalEscape(token.current, onClose, !busy);

  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && closeOnBackdrop && !busy) onClose();
  };

  return (
    <div className={`um-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`} onClick={onBackdrop}>
      <div
        ref={ref}
        className={`um-card um-${size} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || !hideClose) && (
          <div className="um-head">
            <h3 className="um-title">{icon && <Icon name={icon} size={16} />}{title}</h3>
            {!hideClose && (
              <button className="um-x" onClick={onClose} disabled={busy} aria-label={t('common.close')} title={t('common.close')} type="button">
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
        )}
        <div className={`um-body ${bodyClassName}`}>{children}</div>
        {footer && <div className="um-foot">{footer}</div>}
      </div>
    </div>
  );
};

export default Modal;
