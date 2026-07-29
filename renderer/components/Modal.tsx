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
 *
 * HOST WINDOW: a Modal renders IN PLACE (it does not portal — see
 * backdropClassName), so it can end up in a detached panel's window. Every
 * listener and every activeElement read below therefore resolves through the
 * dialog's own document / the host-window context instead of the module-scope
 * globals. In the main window the context default IS `window`/`document`, so
 * nothing changes there; in a child window it is the difference between a
 * working focus trap and a dialog that pins focus to its first control and
 * swallows Escape.
 */

import React, { useEffect, useRef } from 'react';
import Icon, { IconName } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { useHostWindow } from '../utils/hostWindow';
import './Modal.css';

/** Escape-to-close, suppressible (e.g. while an async action is in flight). */
export function useEscape(onClose: () => void, active = true): void {
  // The hook — not its ~15 call sites — consumes the host window, so every
  // existing caller becomes window-correct with no diff of its own.
  const host = useHostWindow();
  useEffect(() => {
    if (!active) return;
    const win = host.window;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [onClose, active, host]);
}

// Stack of currently-open modals (innermost last). Escape closes only the
// topmost one, so a confirm/alert shown OVER another dialog doesn't dismiss the
// layer beneath it. Each Modal registers a token while mounted.
//
// Deliberately module-global, i.e. SHARED ACROSS WINDOWS: the React tree is one
// tree no matter which window its DOM lives in, so a confirm popped in a
// detached panel is still logically "on top" of a dialog in the main window.
// Making the stack per-window would leave Escape ordering between two windows
// undefined. Only the key LISTENER follows the host window.
const modalStack: object[] = [];

/**
 * Is any modal currently open?
 *
 * Exported because this stack is already the app's only Escape-priority registry,
 * and a surface that consumes Escape for something OTHER than closing a layer has
 * no other way to yield to a dialog. Modal shields itself with `stopPropagation`
 * on the WINDOW, which does not help a listener bound lower down: keydown bubbles
 * document-before-window, so a document-level handler has already run by then. Such
 * a handler must ASK instead — the room's theater mode is the first caller.
 *
 * Cross-window by construction, like the stack: a dialog open in a torn-off panel
 * still outranks an Escape typed in the main window, which is the same ordering
 * Escape-closes-the-topmost already promises.
 */
export function isModalOpen(): boolean {
  return modalStack.length > 0;
}

function useModalEscape(token: object, onClose: () => void, active: boolean): void {
  const host = useHostWindow();
  useEffect(() => {
    modalStack.push(token);
    return () => { const i = modalStack.indexOf(token); if (i >= 0) modalStack.splice(i, 1); };
  }, [token]);
  useEffect(() => {
    if (!active) return;
    const win = host.window;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) { e.stopPropagation(); onClose(); }
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [token, onClose, active, host]);
}

/**
 * Where focus sits relative to the dialog when Tab is pressed. Every flag is a
 * fact about ONE document's `activeElement` — which is exactly the read that
 * breaks when it comes from the wrong document: a child-window dialog measured
 * against the MAIN document reports `hasActive` with `insideDialog: false` on
 * every keystroke, so Tab snaps back to the first control forever and the trap
 * becomes a cage. Modelling it as data makes that failure a unit test.
 *
 * The flags are not mutually exclusive on purpose: a dialog with a single
 * focusable control has `isFirst && isLast`.
 */
export interface TrapState {
  /** The document reported an activeElement at all. */
  hasActive: boolean;
  /** …and it is the dialog or a descendant of it. */
  insideDialog: boolean;
  /** …and it is the dialog card itself (tabIndex={-1}), not a control. */
  isDialog: boolean;
  isFirst: boolean;
  isLast: boolean;
}

/** Pure statement of the trap's wrap-around rules. `null` = let the browser move focus. */
export function resolveTrapMove(s: TrapState, shiftKey: boolean): 'first' | 'last' | null {
  if (!s.hasActive) return null;
  if (!s.insideDialog) return 'first';
  if (shiftKey && (s.isFirst || s.isDialog)) return 'last';
  if (!shiftKey && s.isLast) return 'first';
  return null;
}

/** Move focus into the dialog on open, trap Tab inside it, restore focus on close. */
export function useModalFocus(): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  const host = useHostWindow();
  useEffect(() => {
    const dialog = ref.current;
    // The dialog element is the authority on which window it lives in — more so
    // than the context, since a caller may portal this subtree elsewhere.
    const doc = dialog?.ownerDocument ?? host.document;
    const prev = doc.activeElement as HTMLElement | null;
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
      const active = doc.activeElement as HTMLElement | null;
      const move = resolveTrapMove({
        hasActive: !!active,
        insideDialog: !!active && dialog.contains(active),
        isDialog: active === dialog,
        isFirst: active === first,
        isLast: active === last,
      }, e.shiftKey);
      if (move === 'first') { e.preventDefault(); first.focus(); }
      else if (move === 'last') { e.preventDefault(); last.focus(); }
    };
    doc.addEventListener('keydown', onKey, true);
    return () => {
      doc.removeEventListener('keydown', onKey, true);
      // Restore into the SAME window we took focus from; restoring a main-window
      // element after a child-window dialog closes can raise the main window
      // over the child on Windows.
      prev?.focus?.();
    };
  }, [host]);
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
