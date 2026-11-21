/** Internal bounded framing. Never log payloads or native TLS errors. */
import { inspect } from "node:util";
import { TextDecoder } from "node:util";
import type { TLSSocket } from "node:tls";
import { DEVICE_FRAME_BYTES, DeviceError } from "../../shared/device-pairing";

export class DeviceWire {
  private buffer: Buffer = Buffer.alloc(0);
  private messages: unknown[] = [];
  private waiter: {
    resolve(value: unknown): void;
    reject(error: DeviceError): void;
  } | null = null;
  private failure: DeviceError | null = null;
  private closeListeners = new Set<() => void>();
  private writing = false;
  constructor(private socket: TLSSocket) {
    socket.setTimeout(15000, () => this.close("state"));
    socket.on("error", () => this.close("peer"));
    socket.on("end", () => this.close("state"));
    socket.on("close", () => this.close("state"));
    socket.on("data", (chunk: Buffer) => {
      try {
        if (this.failure) return;
        if (this.buffer.length + chunk.length > 4 * (DEVICE_FRAME_BYTES + 4))
          throw new DeviceError("size");
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32BE();
          if (!length || length > DEVICE_FRAME_BYTES)
            throw new DeviceError("size");
          if (this.buffer.length < length + 4) break;
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              this.buffer.subarray(4, length + 4),
            ),
          );
          this.buffer = this.buffer.subarray(length + 4);
          if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter.resolve(value);
          } else {
            if (this.messages.length >= 4) throw new DeviceError("quota");
            this.messages.push(value);
          }
        }
      } catch (error) {
        this.close(error instanceof DeviceError ? error.code : "invalid");
      }
    });
  }
  toJSON() {
    return { closed: !!this.failure };
  }
  [inspect.custom]() {
    return this.toJSON();
  }
  security() {
    this.assertOpen();
    return {
      protocol: this.socket.getProtocol(),
      alpn: this.socket.alpnProtocol,
      resumed: this.socket.isSessionReused(),
      authorized: this.socket.authorized,
    };
  }
  idleTimeout(ms: number) {
    this.assertOpen();
    this.socket.setTimeout(Math.max(1000, Math.min(ms, 600000)));
  }
  assertOpen(): void {
    if (this.failure || this.socket.destroyed)
      throw this.failure ?? new DeviceError("state");
  }
  onClose(listener: () => void): () => void {
    if (this.failure) listener();
    else this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  binding(): string {
    this.assertOpen();
    try {
      return this.socket
        .exportKeyingMaterial(32, "EXPORTER-Channel-Binding", Buffer.alloc(0))
        .toString("hex");
    } catch {
      throw new DeviceError("peer");
    }
  }
  read(): Promise<unknown> {
    this.assertOpen();
    if (this.waiter) throw new DeviceError("state");
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  write(value: unknown, guard: () => void = () => {}): Promise<void> {
    this.assertOpen();
    if (this.writing) throw new DeviceError("quota");
    let payload: Buffer;
    try {
      payload = Buffer.from(JSON.stringify(value));
    } catch {
      throw new DeviceError("invalid");
    }
    if (!payload.length || payload.length > DEVICE_FRAME_BYTES)
      throw new DeviceError("size");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    // No await between the current grant check and handing bytes to TLS.
    guard();
    this.writing = true;
    return new Promise((resolve, reject) => {
      this.socket.write(Buffer.concat([header, payload]), (error) => {
        this.writing = false;
        if (error || this.failure) reject(new DeviceError("peer"));
        else resolve();
      });
    });
  }
  close(code: DeviceError["code"] = "state"): void {
    if (this.failure) return;
    this.failure = new DeviceError(code);
    this.waiter?.reject(this.failure);
    this.waiter = null;
    this.messages = [];
    this.buffer = Buffer.alloc(0);
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        /* Closing is unconditional. */
      }
    }
    this.closeListeners.clear();
    this.socket.destroy();
  }
}
