import { fileProgress } from '../../shared/file-progress';

interface PieceSnapshot {
  pieceLength: number;
  bitfield?: { get(index: number): boolean };
}
interface FileSpan { offset: number; length: number }

/** Count only the file's overlap with verified pieces, including shared edges.
 * WebTorrent's File.downloaded subtracts both margins from the same partial
 * piece for a tiny file, which can make its byte count negative. It also loses
 * a whole final piece when a file ends exactly on a piece boundary.
 */
export function verifiedFileProgress(torrent: PieceSnapshot, file: FileSpan) {
  const { offset, length } = file;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
      !Number.isSafeInteger(offset + length)) return fileProgress(NaN, 0);
  const size = torrent.pieceLength;
  if (!Number.isSafeInteger(size) || size <= 0 || !torrent.bitfield) return fileProgress(length, 0);
  const end = offset + length;
  let downloaded = 0;
  for (let index = Math.floor(offset / size); index < Math.ceil(end / size); index++) {
    if (torrent.bitfield.get(index)) downloaded += Math.min(end, (index + 1) * size) - Math.max(offset, index * size);
  }
  return fileProgress(length, downloaded);
}
