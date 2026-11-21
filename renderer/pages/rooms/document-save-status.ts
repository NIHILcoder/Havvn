import type { DocumentOpenView } from '../../../shared/room-documents';

type SaveView = Pick<DocumentOpenView, 'pending' | 'localDraft' | 'blockedPending' | 'recovering' | 'transferring'>;

/** An owner-confirmed version does not imply a receipt from every participant. */
export function documentSaveStatus(view: SaveView, unsaved: boolean) {
  if (unsaved) return 'rooms.docs.saving' as const;
  if (view.transferring) return 'rooms.docs.transferring' as const;
  if (view.recovering) return 'rooms.docs.recovering' as const;
  if (view.blockedPending) return 'rooms.docs.needsReview' as const;
  if (view.pending > 0 || view.localDraft) return 'rooms.docs.localSaved' as const;
  return 'rooms.docs.synced' as const;
}
