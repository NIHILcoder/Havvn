/**
 * Decode a transmission `pieces` base64 bitfield (MSB-first, piece 0 = bit 7
 * of byte 0) and collapse it to a UI-sized row of 0..1 fills.
 */

import type { TorrentPieces } from './types';

export const PIECE_MAP_BUCKETS = 160;

export const EMPTY_PIECES: TorrentPieces = { pieceCount: 0, pieceSize: 0, haveCount: 0, buckets: [] };

export function haveFromBitfield(buf: Uint8Array, pieceCount: number): Uint8Array {
  const n = Math.max(0, pieceCount | 0);
  const have = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const byte = buf[i >> 3];
    if (byte === undefined) break;
    have[i] = (byte & (0x80 >> (i & 7))) ? 1 : 0;
  }
  return have;
}

export function decodePieceBitfield(b64: string, pieceCount: number): Uint8Array {
  if (!b64 || pieceCount <= 0) return new Uint8Array(Math.max(0, pieceCount | 0));
  try {
    return haveFromBitfield(Buffer.from(b64, 'base64'), pieceCount);
  } catch {
    return new Uint8Array(pieceCount);
  }
}

export function bucketHave(have: Uint8Array, maxBuckets: number = PIECE_MAP_BUCKETS): number[] {
  const n = have.length;
  if (n <= 0) return [];
  const buckets = Math.min(n, Math.max(1, maxBuckets | 0));
  const out = new Array<number>(buckets);
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * n) / buckets);
    const end = Math.floor(((i + 1) * n) / buckets);
    const span = Math.max(1, end - start);
    let sum = 0;
    for (let j = start; j < end; j++) sum += have[j];
    out[i] = sum / span;
  }
  return out;
}

export function summarizeHave(have: Uint8Array, pieceSize: number): TorrentPieces {
  let haveCount = 0;
  for (let i = 0; i < have.length; i++) haveCount += have[i];
  return {
    pieceCount: have.length,
    pieceSize: Math.max(0, pieceSize | 0),
    haveCount,
    buckets: bucketHave(have),
  };
}

export function summarizePieces(b64: string, pieceCount: number, pieceSize: number): TorrentPieces {
  if (pieceCount <= 0) return EMPTY_PIECES;
  return summarizeHave(decodePieceBitfield(b64, pieceCount), pieceSize);
}
