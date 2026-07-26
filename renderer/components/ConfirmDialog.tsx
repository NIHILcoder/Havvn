/**
 * Themed confirm / alert — the Ember replacement for the browser's blocking
 * window.confirm() / window.alert(). Mount <ConfirmProvider> once near the app
 * root, then call const { confirm, alert } = useConfirm() anywhere:
 *
 *   if (await confirm({ message: 'Remove this download?', danger: true })) …
 *   await alert({ title: 'Add failed', message: err });
 *
 * Both return promises, so call sites become async but read the same as before.
 */

import React, { createContext, useCallback, useContext, useReducer, useRef } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { IconName } from './Icon';
import { useTranslation } from '../utils/i18nContext';

export interface ConfirmOptions {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  icon?: IconName;
}
export interface AlertOptions {
  title?: string;
  message: React.ReactNode;
  okLabel?: string;
  icon?: IconName;
}

interface ConfirmApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

type Req =
  | ({ kind: 'confirm' } & ConfirmOptions & { resolve: (v: boolean) => void })
  | ({ kind: 'alert' } & AlertOptions & { resolve: () => void });

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  // A QUEUE, not a single slot: a confirm()/alert() raised while another is open
  // waits its turn instead of clobbering the first's resolver (which would leave
  // the first promise unsettled forever). The head is the visible dialog.
  const queue = useRef<Req[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const req = queue.current[0] || null;

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    queue.current.push({ kind: 'confirm', ...opts, resolve });
    bump();
  }), []);
  const alert = useCallback((opts: AlertOptions) => new Promise<void>((resolve) => {
    queue.current.push({ kind: 'alert', ...opts, resolve });
    bump();
  }), []);

  const close = (value: boolean) => {
    const head = queue.current.shift();
    if (!head) return;
    if (head.kind === 'confirm') head.resolve(value);
    else head.resolve();
    bump();
  };

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      {req && (
        <Modal
          size="sm"
          icon={req.icon || (req.kind === 'confirm' && req.danger ? 'alert-triangle' : undefined)}
          title={req.title || (req.kind === 'confirm' ? t('common.confirm') : t('common.notice'))}
          onClose={() => close(false)}
          // A confirm is asked ABOUT whatever is already open, so it must never
          // land underneath it. Without this it does: Modal renders in place, and
          // this provider sits near the app root, so a dialog that portals to
          // <body> (e.g. a picker) comes later in the DOM and wins at equal
          // z-index — the confirm appears BEHIND the modal that requested it and
          // the user has to close that modal to reach it.
          backdropClassName="um-backdrop-top"
          bodyClassName="um-body-plain"
          footer={req.kind === 'confirm' ? (
            <>
              <Button variant="ghost" onClick={() => close(false)}>{req.cancelLabel || t('common.cancel')}</Button>
              <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{req.confirmLabel || t('common.confirm')}</Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => close(false)}>{req.okLabel || t('common.ok')}</Button>
          )}
        >
          <p>{req.message}</p>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
};
