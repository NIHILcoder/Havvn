import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packSyncLog, unpackSyncLog, SYNC_LOG_DECODE_BYTES } from './room-sync-log-pack';
import type { SyncRecord } from '../../shared/room-file-sync';

describe('bounded local sync archive codec', () => {
  const records = [{ kind: 'policy', value: { label: 'Кириллица и UTF-8' } }] as unknown as SyncRecord[];
  it('round-trips deterministic canonical bytes and rejects invalid headers and counts', () => {
    const packed = packSyncLog(records); expect(unpackSyncLog(packed)).toEqual(records); expect(packSyncLog(records)).toEqual(packed);
    for (const changes of [{ codec: 'unknown' }, { bytes: 0 }, { bytes: SYNC_LOG_DECODE_BYTES + 1 }, { records: 10065 }, { records: 2 }, { digest: 'a'.repeat(64) }, { data: packed.data + '\n' }]) {
      expect(() => unpackSyncLog({ ...packed, ...changes })).toThrow();
    }
    expect(() => packSyncLog([])).toThrow();
  });
  it('limits inflation even for a highly compressible bomb with a forged small length', () => {
    const packed = packSyncLog(records), data = gzipSync(Buffer.alloc(2 * 1024 * 1024)).toString('base64');
    expect(() => unpackSyncLog({ ...packed, data, bytes: 32 })).toThrow();
  });
  it('rejects corrupt, truncated, invalid JSON and noncanonical UTF-8 archives', () => {
    const packed = packSyncLog(records), compressed = Buffer.from(packed.data, 'base64'); compressed[compressed.length - 1] ^= 1;
    expect(() => unpackSyncLog({ ...packed, data: compressed.toString('base64') })).toThrow();
    expect(() => unpackSyncLog({ ...packed, data: Buffer.from(packed.data, 'base64').subarray(0, 10).toString('base64') })).toThrow();
    for (const bytes of [Buffer.from('invalid json'), Buffer.from('[\xff]','latin1'), Buffer.from('[ ]')]) {
      expect(() => unpackSyncLog({ ...packed, bytes: bytes.length, digest: crypto.createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') })).toThrow();
    }
  });
});
