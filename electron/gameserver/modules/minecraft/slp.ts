/**
 * Minecraft Server List Ping — the handshake a client performs to draw one row
 * of the multiplayer list. We use it as the authoritative population probe.
 *
 * WHY NOT JUST COUNT LOG LINES: log scraping loses track the moment a line is
 * missed — a restart, a rotated log, a mod that suppresses join messages, or
 * simply our own parser being started after the server was already up. The SLP
 * response is a fresh statement of truth from the server itself, so the counter
 * self-heals every poll. Log events still drive the fast path (a join shows
 * immediately); this corrects it.
 *
 * WHY NOT RCON: RCON would also give us this, but it requires enabling a remote
 * console with a password in server.properties and opening another port —
 * strictly more attack surface for strictly less than what stdin already gives
 * us on the machine we are already running on.
 *
 * Wire format (protocol ≥ 47): a length-prefixed handshake packet with next-state
 * 1, then an empty status-request packet; the server replies with one JSON blob.
 */
import net from 'net';

/** Bound on the status response. A legitimate one is a few KB; the field is
 *  length-prefixed by the server, so this stops a hostile or broken peer from
 *  making us allocate. */
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Protocol version sent in the handshake. -1 means "unspecified", which every
 *  server answers, and avoids pretending to be a particular client build. */
const PROTOCOL_UNSPECIFIED = -1;

export interface SlpResult {
  online: number;
  max: number;
  names: string[];
  motd: string;
  version: string;
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  if (value < 0) v = (value >>> 0);
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeString(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Wrap a payload in its length prefix. */
function packet(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeVarInt(body.length), body]);
}

interface VarIntRead { value: number; size: number }

function readVarInt(buf: Buffer, offset: number): VarIntRead | null {
  let value = 0;
  // A VarInt is at most five bytes, so the protocol's own limit is the loop's
  // bound: a sixth continuation byte is malformed input, not "more to come",
  // and a server that sends one must not be able to spin us.
  for (let size = 0; size < 5; size++) {
    if (offset + size >= buf.length) return null; // need more bytes
    const byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    if ((byte & 0x80) === 0) return { value, size: size + 1 };
  }
  throw new Error('malformed varint');
}

interface StatusJson {
  players?: { online?: number; max?: number; sample?: { name?: string }[] };
  description?: unknown;
  version?: { name?: string };
}

/** The description field is a string on old servers and a chat component on new
 *  ones; flatten either into plain text. */
function flattenDescription(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenDescription).join('');
  if (node && typeof node === 'object') {
    const obj = node as { text?: unknown; extra?: unknown };
    return `${typeof obj.text === 'string' ? obj.text : ''}${obj.extra ? flattenDescription(obj.extra) : ''}`;
  }
  return '';
}

/**
 * Query a server. Resolves with its status, or rejects on timeout / refusal —
 * which the caller should treat as "not answering yet", not as an error worth
 * showing: a server that is still generating a world legitimately refuses
 * connections for a while.
 */
export function pingMinecraft(host: string, port: number, timeoutMs = 3000): Promise<SlpResult> {
  return new Promise<SlpResult>((resolve, reject) => {
    const socket = new net.Socket();
    let chunks = Buffer.alloc(0);
    let settled = false;

    const finish = (err: Error | null, value?: SlpResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve(value as SlpResult);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error('slp timeout')));
    socket.on('error', (err) => finish(err));

    socket.connect(port, host, () => {
      socket.write(packet(
        writeVarInt(0x00),
        writeVarInt(PROTOCOL_UNSPECIFIED),
        writeString(host),
        (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; })(),
        writeVarInt(1),
      ));
      socket.write(packet(writeVarInt(0x00)));
    });

    socket.on('data', (chunk) => {
      chunks = Buffer.concat([chunks, chunk]);
      if (chunks.length > MAX_RESPONSE_BYTES) {
        finish(new Error('slp response too large'));
        return;
      }
      try {
        const length = readVarInt(chunks, 0);
        if (!length) return;
        const packetId = readVarInt(chunks, length.size);
        if (!packetId) return;
        if (packetId.value !== 0x00) { finish(new Error(`unexpected slp packet ${packetId.value}`)); return; }
        const strLen = readVarInt(chunks, length.size + packetId.size);
        if (!strLen) return;
        const start = length.size + packetId.size + strLen.size;
        if (chunks.length < start + strLen.value) return; // still arriving

        const json = JSON.parse(chunks.subarray(start, start + strLen.value).toString('utf8')) as StatusJson;
        const sample = Array.isArray(json?.players?.sample) ? json.players.sample : [];
        finish(null, {
          online: Number(json?.players?.online ?? 0) || 0,
          max: Number(json?.players?.max ?? 0) || 0,
          // `sample` is capped by the server (usually 12) and may be absent
          // entirely, so it is a hint for the tooltip, never the count itself.
          names: sample.map((s) => (typeof s?.name === 'string' ? s.name : '')).filter(Boolean),
          motd: flattenDescription(json?.description).slice(0, 200),
          version: typeof json?.version?.name === 'string' ? json.version.name : '',
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
