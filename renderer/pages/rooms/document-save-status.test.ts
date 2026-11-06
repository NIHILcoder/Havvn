import { expect, it } from 'vitest';
import { documentSaveStatus } from './document-save-status';

const confirmed = { pending: 0, localDraft: false, blockedPending: false };
it.each([
  [{ ...confirmed }, false, 'rooms.docs.synced'],
  [{ ...confirmed, pending: 1 }, false, 'rooms.docs.localSaved'],
  [{ ...confirmed, localDraft: true }, false, 'rooms.docs.localSaved'],
  [{ ...confirmed, blockedPending: true }, false, 'rooms.docs.needsReview'],
  [{ ...confirmed, localDraft: true, blockedPending: true }, false, 'rooms.docs.needsReview'],
  [{ ...confirmed, recovering: true, pending: 2 }, false, 'rooms.docs.recovering'],
  [{ ...confirmed, transferring: true, recovering: true }, false, 'rooms.docs.transferring'],
  [{ ...confirmed, transferring: true, pending: 2 }, true, 'rooms.docs.saving'],
  [{ ...confirmed }, true, 'rooms.docs.saving'],
] as const)('distinguishes durable drafts, confirmed history and unfinished input: %j', (view, unsaved, expected) => {
  expect(documentSaveStatus(view, unsaved)).toBe(expected);
});
