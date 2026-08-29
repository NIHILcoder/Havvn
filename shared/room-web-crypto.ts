/**
 * Browser-safe room crypto. Byte-identical to electron/sharing/room-crypto.ts
 * (PBKDF2-SHA256 150k, AES-GCM iv|tag|cipher, HMAC-SHA1 rendezvous, SHA-1 topic,
 * SHA-256 member id, Ed25519 PEM).
 *
 * Uses Web Crypto so the guest page and Node tests (via crypto.webcrypto) share
 * one implementation. The engine keeps the Node `crypto` module — this file is
 * the guest + interop-test side.
 */

import { normalizeCode } from './room-invite';

const SALT_STR = 'torrenthunt-room-v1';
const PBKDF2_ITERS = 150_000;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('Web Crypto is unavailable');
  return c.subtle;
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/** SubtleCrypto rejects the generic `Uint8Array` (ArrayBufferLike) in TS 5.7+. */
function asSource(u: Uint8Array): Uint8Array<ArrayBuffer> {
  if (u.buffer instanceof ArrayBuffer) return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let h = '';
  for (let i = 0; i < u.length; i++) h += u[i].toString(16).padStart(2, '0');
  return h;
}

export function bytesToBase64(u: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(u).toString('base64');
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function derToPem(der: Uint8Array, label: 'PUBLIC KEY' | 'PRIVATE KEY'): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [A-Z ]+-----/, '').replace(/-----END [A-Z ]+-----/, '').replace(/\s+/g, '');
  return base64ToBytes(body);
}

export async function deriveKeyWeb(code: string): Promise<Uint8Array> {
  const s = subtle();
  const material = await s.importKey('raw', asSource(utf8(normalizeCode(code))), 'PBKDF2', false, ['deriveBits']);
  const bits = await s.deriveBits(
    { name: 'PBKDF2', salt: asSource(utf8(SALT_STR)), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function topicHashWeb(code: string): Promise<string> {
  const digest = await subtle().digest('SHA-1', asSource(utf8('th-room:v1:' + normalizeCode(code))));
  return toHex(digest);
}

export async function rendezvousIdWeb(key: Uint8Array): Promise<string> {
  const cryptoKey = await subtle().importKey('raw', asSource(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await subtle().sign('HMAC', cryptoKey, asSource(utf8('th-room-rv:v1')));
  return toHex(sig);
}

export async function deriveMemberIdWeb(pub: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', asSource(utf8(pub)));
  return toHex(digest).slice(0, 32);
}

export async function encryptWeb(key: Uint8Array, obj: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ck = await subtle().importKey('raw', asSource(key), 'AES-GCM', false, ['encrypt']);
  const packed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: asSource(iv), tagLength: 128 }, ck, asSource(utf8(JSON.stringify(obj)))));
  const tag = packed.subarray(packed.length - 16);
  const enc = packed.subarray(0, packed.length - 16);
  const out = new Uint8Array(12 + 16 + enc.length);
  out.set(iv, 0);
  out.set(tag, 12);
  out.set(enc, 28);
  return bytesToBase64(out);
}

export async function decryptWeb<T = unknown>(key: Uint8Array, token: string): Promise<T> {
  const buf = base64ToBytes(token);
  if (buf.length < 28) throw new Error('cipher too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const packed = new Uint8Array(enc.length + 16);
  packed.set(enc, 0);
  packed.set(tag, enc.length);
  const ck = await subtle().importKey('raw', asSource(key), 'AES-GCM', false, ['decrypt']);
  const dec = await subtle().decrypt({ name: 'AES-GCM', iv: asSource(iv), tagLength: 128 }, ck, asSource(packed));
  return JSON.parse(new TextDecoder().decode(dec)) as T;
}

export interface GuestIdentity {
  pub: string;
  priv: string;
  memberId: string;
}

export async function generateIdentityWeb(): Promise<GuestIdentity> {
  const kp = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  const pub = derToPem(spki, 'PUBLIC KEY');
  const priv = derToPem(pkcs8, 'PRIVATE KEY');
  return { pub, priv, memberId: await deriveMemberIdWeb(pub) };
}

export async function signWeb(privPem: string, bytes: Uint8Array): Promise<string> {
  const key = await subtle().importKey('pkcs8', asSource(pemToDer(privPem)), { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key, asSource(bytes)));
  return bytesToBase64(sig);
}

export async function verifyWeb(pubPem: string, bytes: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    const key = await subtle().importKey('spki', asSource(pemToDer(pubPem)), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, asSource(base64ToBytes(sigB64)), asSource(bytes));
  } catch {
    return false;
  }
}

export function randomHex(bytes: number): string {
  const u = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return toHex(u);
}

/** WebTorrent / bittorrent-tracker wire form: 20-byte hex → latin1 binary string. */
export function hexToBinary(hex: string): string {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2) throw new Error('bad hex');
  let s = '';
  for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
}

export function binaryToHex(bin: string): string {
  let h = '';
  for (let i = 0; i < bin.length; i++) h += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return h;
}
