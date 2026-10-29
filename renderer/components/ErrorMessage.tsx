import React, { useSyncExternalStore } from 'react';
import { userErrorDetails, type ErrorLanguage } from '../../shared/user-errors';
import { errorPresentationSnapshot, readableError, subscribeErrorPresentation } from '../utils/error-messages';
import './ErrorMessage.css';

/** Format at render time, so saved failures and open dialogs follow language changes. */
export function ErrorMessage({ error, details = false, language: override, summary }: { error: unknown; details?: boolean; language?: ErrorLanguage; summary?: string }) {
  const snapshot = useSyncExternalStore(subscribeErrorPresentation, errorPresentationSnapshot, () => 'en:0');
  const language = override ?? (snapshot.startsWith('ru:') ? 'ru' : 'en');
  const message = summary ?? readableError(error, language), technical = details ? userErrorDetails(error) : '';
  if (!technical || technical.trim() === message.trim()) return <>{message}</>;
  return <div className="user-error-message" lang={language}>
    <span>{message}</span>
    <details className="user-error-details"><summary>{language === 'ru' ? 'Технические подробности' : 'Technical details'}</summary><pre>{technical}</pre></details>
  </div>;
}
