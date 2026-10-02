import fs from 'fs';

export const ROOM_DISK_RESERVE = 256n * 1024n * 1024n;
type Probe = (root: string) => { volume: string; free: bigint };
const diskProbe: Probe = root => {
  const info = fs.statfsSync(root, { bigint: true });
  return { volume: String(fs.statSync(root, { bigint: true }).dev), free: info.bavail * info.bsize };
};

/** Reserves all destination volumes atomically, including E2E plaintext output. */
export class RoomDiskBudget {
  private reserved = new Map<string, bigint>();
  constructor(private probe: Probe = diskProbe, private floor = ROOM_DISK_RESERVE) {}
  assertAvailable(root: string): void {
    if (this.probe(root).free < this.floor) throw this.diskFull();
  }
  private diskFull(): Error {
    return Object.assign(new Error('Not enough disk space for this room file and the 256 MiB safety reserve. Free space and retry.'), { code: 'ENOSPC' });
  }
  reserve(requests: Array<{ root: string; bytes: number }>): () => void {
    const needs = new Map<string, { bytes: bigint; free: bigint }>();
    for (const request of requests) {
      if (!Number.isSafeInteger(request.bytes) || request.bytes < 0) throw new Error('Invalid room file size');
      const disk = this.probe(request.root), prior = needs.get(disk.volume);
      needs.set(disk.volume, { bytes: (prior?.bytes ?? 0n) + BigInt(request.bytes), free: prior && prior.free < disk.free ? prior.free : disk.free });
    }
    for (const [volume, need] of needs) if (need.free - (this.reserved.get(volume) ?? 0n) - need.bytes < this.floor) {
      throw this.diskFull();
    }
    for (const [volume, need] of needs) this.reserved.set(volume, (this.reserved.get(volume) ?? 0n) + need.bytes);
    let released = false;
    return () => {
      if (released) return; released = true;
      for (const [volume, need] of needs) { const left = (this.reserved.get(volume) ?? 0n) - need.bytes; if (left) this.reserved.set(volume, left); else this.reserved.delete(volume); }
    };
  }
}
