import type { RoomFile, RoomTransfer } from '../../../shared/types';
import { roomTransferView } from '../../../shared/room-transfer';

export interface FileSelectionGesture {
  range?: boolean;
  additive?: boolean;
  replace?: boolean;
}

/** Range endpoints are ids, so sorting/filtering cannot leave a stale index. */
export function selectRoomFiles(
  selected: ReadonlySet<string>, order: readonly string[], anchor: string | null,
  target: string, gesture: FileSelectionGesture = {},
): Set<string> {
  const end = order.indexOf(target);
  if (end < 0) return new Set(selected);
  if (gesture.replace && !gesture.range) return new Set([target]);
  const next = new Set(gesture.range && !gesture.additive ? [] : selected);
  if (gesture.range) {
    const start = anchor === null ? -1 : order.indexOf(anchor);
    for (const id of order.slice(start < 0 ? end : Math.min(start, end), start < 0 ? end + 1 : Math.max(start, end) + 1)) next.add(id);
  } else if (next.has(target)) next.delete(target);
  else next.add(target);
  return next;
}

/** Match the single-file actions, especially ciphertext that still needs decrypt. */
export function roomFileReceiveActions(
  files: readonly RoomFile[], transfers: Record<string, RoomTransfer>, autoFetch: boolean,
  selected: ReadonlySet<string>,
) {
  const fetch: string[] = [], pause: string[] = [];
  for (const file of files) {
    if (!selected.has(file.fileId)) continue;
    const tr = transfers[file.fileId], view = roomTransferView(file, tr, autoFetch);
    if (view.fetch) fetch.push(file.fileId);
    if (view.downloading || tr?.queuePosition !== undefined) pause.push(file.fileId);
  }
  return { fetch, pause };
}
