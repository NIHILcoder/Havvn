import React, { useEffect, useRef, useState } from 'react';
import { ErrorMessage } from './ErrorMessage';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
import './RecoveryError.css';

export interface RecoveryAction {
  id: string;
  label: string;
  run(): void | Promise<void>;
  /** A completed retry is not offered again for the same failure. */
  kind?: 'retry' | 'open';
  disabled?: boolean;
}
export interface ErrorRecoveryContext {
  object: string;
  actions?: readonly RecoveryAction[];
  onOpenEvents?(): void;
}

/** The caller supplies supported recovery actions; text never authorizes a retry. */
export function RecoveryError({ error, context, summary }: { error?: unknown; context: ErrorRecoveryContext; summary?: string }) {
  const { t } = useTranslation(), alive = useRef(true), running = useRef(false);
  const [busy, setBusy] = useState(''), [completed, setCompleted] = useState<string[]>([]), [failure, setFailure] = useState<unknown>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const perform = async (action: RecoveryAction) => {
    if (running.current || action.disabled || completed.includes(action.id)) return;
    running.current = true; setBusy(action.id); setFailure(null);
    try { await action.run(); if (alive.current && action.kind === 'retry') setCompleted(ids => [...ids, action.id]); }
    catch (cause) { if (alive.current) setFailure(cause); }
    finally { running.current = false; if (alive.current) setBusy(''); }
  };
  return <div className="recovery-error" data-recovery-error>
    <strong className="recovery-error-object">{context.object}</strong>
    {error !== undefined && <div role="alert"><ErrorMessage error={error} details summary={summary} /></div>}
    <div className="recovery-error-actions">{context.actions?.map(action => <Button key={action.id} size="sm" variant="secondary" disabled={!!busy || action.disabled || completed.includes(action.id)} loading={busy === action.id} onClick={() => { void perform(action); }}>{action.label}</Button>)}
      {context.onOpenEvents && <Button variant="ghost" size="sm" disabled={!!busy} onClick={context.onOpenEvents}>{t('recovery.events')}</Button>}
    </div>
    {!!completed.length && <p role="status">{t('recovery.completed')}</p>}
    {failure !== null && <div role="alert"><ErrorMessage error={failure} details /></div>}
  </div>;
}
