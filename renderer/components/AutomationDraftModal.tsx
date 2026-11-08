import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';
import { useConfirm } from './ConfirmDialog';
import { useHostWindow } from '../utils/hostWindow';
import { useTranslation } from '../utils/i18nContext';
import type { AutomationDraft } from '../../shared/automation-draft';
import { pageLeave } from '../state/page-leave';
const Section = lazy(() => import('../pages/settings/sections/AutomationSection').then(m => ({ default: m.AutomationSection })));
export function AutomationDraftModal({ draft, onClose }: { draft: AutomationDraft; onClose(): void }) {
  const { t } = useTranslation(), host = useHostWindow(), { confirm } = useConfirm();
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => pageLeave.register(async () => !busy && (!dirty || await confirm({ message: t('automation.from.discard'), danger: true }))), [busy, dirty, confirm, t]);
  const close = async () => { if (busy) return; if (!dirty || await confirm({ message: t('automation.from.discard'), danger: true })) onClose(); };
  return createPortal(<Modal size="xl" title={t('automation.from.title')} icon="sliders" busy={busy} onClose={() => { void close(); }} closeOnBackdrop={false}>
    <p>{t('automation.from.hint')} <strong>{draft.origin}</strong></p>
    <Suspense fallback={<p role="status">{t('common.loading')}</p>}><Section initialDraft={draft} onDirtyChange={setDirty} onBusyChange={setBusy} /></Suspense>
  </Modal>, host.document.body);
}
