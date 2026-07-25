/**
 * Length-prefixed framing for the helper↔engine raw-packet bridge (plan §1.1).
 *
 * The bridge is a byte STREAM (named pipe): writes coalesce and a single frame
 * can split across reads, so both ends reassemble via a 2-byte big-endian length
 * prefix: [uint16 len][payload]. uint16 covers any MTU-sized IP frame. Pure +
 * unit-testable; this exact reassembler is what Phase 1 uses on both sides.
 */

export const FRAME_HEADER = 2;
export const MAX_FRAME = 0xffff;

/** Wrap a payload as [uint16 len][payload]. */
export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME) throw new Error(`frame too large: ${payload.length} > ${MAX_FRAME}`);
  const out = Buffer.allocUnsafe(FRAME_HEADER + payload.length);
  out.writeUInt16BE(payload.length, 0);
  payload.copy(out, FRAME_HEADER);
  return out;
}

/**
 * Streaming reassembler. Feed raw chunks via push(); complete payloads are
 * delivered to onFrame in order. Throws on an oversized length prefix (a hostile
 * or corrupt peer/helper) — the caller must treat that as a fatal transport
 * error and tear the bridge down, never resync past it.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private need = -1; // payload length once the header is parsed, else -1

  constructor(private readonly maxFrame: number = MAX_FRAME) {}

  push(chunk: Buffer, onFrame: (payload: Buffer) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.need < 0) {
        if (this.buf.length < FRAME_HEADER) return;
        this.need = this.buf.readUInt16BE(0);
        if (this.need > this.maxFrame) throw new Error(`oversized frame: ${this.need} > ${this.maxFrame}`);
        this.buf = this.buf.subarray(FRAME_HEADER);
      }
      if (this.buf.length < this.need) return;
      // Copy out so the consumer may retain the payload past this call (the
      // internal buffer is reassigned to a later view of the same memory).
      onFrame(Buffer.from(this.buf.subarray(0, this.need)));
      this.buf = this.buf.subarray(this.need);
      this.need = -1;
    }
  }
}
