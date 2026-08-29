/**
 * Browser-guest room URL. Same hosting pattern as Instant Share:
 * https://nihilcoder.github.io/Havvn/room/#<invite>
 *
 * Optional `?tr=` entries carry the room's actual rendezvous trackers when the
 * host is not on the public set — resolveTrackers REPLACES defaults, so a
 * custom-tracker room is invisible to a guest that only knows the public list.
 */

import { parseInvite } from './room-invite';
import { parseTrackers } from './trackers';

export const ROOM_GUEST_BASE = 'https://nihilcoder.github.io/Havvn/room/';

/** Public WSS trackers — keep in sync with ice-servers.ts / share / watch. */
export const PUBLIC_RENDEZVOUS_TRACKERS: readonly string[] = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

export const PUBLIC_STUN_SERVERS: readonly { urls: string }[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/**
 * Build the shareable browser-join URL.
 * `trackers` is the list the room actually announces to. Encoded only when
 * non-empty so the common (public) QR stays short.
 */
export function buildGuestUrl(invite: string, trackers?: string[]): string {
  const hash = encodeURIComponent((invite || '').trim());
  const extra = (trackers || []).map((t) => t.trim()).filter(Boolean);
  const q = extra.length
    ? '?' + extra.map((t) => 'tr=' + encodeURIComponent(t)).join('&')
    : '';
  return `${ROOM_GUEST_BASE}${q}#${hash}`;
}

export interface ParsedGuestLocation {
  invite: string;
  code: string;
  ownerPin: string;
  trackers: string[];
}

/** Read invite + trackers from a page location (hash + search). */
export function parseGuestLocation(hash: string, search: string): ParsedGuestLocation {
  let raw = (hash || '').replace(/^#/, '');
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  const invite = raw.trim();
  const parsed = parseInvite(invite);
  const params = new URLSearchParams((search || '').replace(/^\?/, ''));
  const fromQuery: string[] = [];
  for (const tr of params.getAll('tr')) {
    const u = tr.trim();
    if (u) fromQuery.push(u);
  }
  // Also accept a comma-joined `c` query as a hash-less fallback (some
  // messengers strip fragments).
  if (!invite) {
    const c = (params.get('c') || '').trim();
    if (c) {
      const p = parseInvite(c);
      return {
        invite: c,
        code: p.code,
        ownerPin: p.ownerPin,
        trackers: resolveGuestTrackers(fromQuery),
      };
    }
  }
  return {
    invite,
    code: parsed.code,
    ownerPin: parsed.ownerPin,
    trackers: resolveGuestTrackers(fromQuery),
  };
}

/** URL trackers win when any are usable; otherwise the public set. */
export function resolveGuestTrackers(fromUrl: string[]): string[] {
  const custom = parseTrackers(fromUrl.join(','));
  return custom.length ? custom : [...PUBLIC_RENDEZVOUS_TRACKERS];
}
