/**
 * Single source of truth for WebRTC connectivity — ICE servers AND the rendezvous
 * trackers — shared by every P2P surface (share links, rooms, remote cast).
 * Previously each module carried its own copy and they drifted.
 *
 * STUN reveals each peer's public address (enough for most home NATs) and is
 * privacy-neutral. TURN would relay the (encrypted) traffic through a third party
 * so peers behind symmetric NAT can still connect — but we bundle NONE (see below).
 *
 * Connectivity ladder (zero-cost, see connectivity-strategy): direct/LAN/IPv6 →
 * STUN hole-punching → peer-relay through a reachable room member → optional
 * user-supplied TURN. The dev runs no servers; the only free external dependency
 * is the public WebRTC rendezvous trackers, which broker the handshake and never
 * see file bytes or plaintext.
 *
 * Keep in sync with the receiver pages (docs/share/index.html,
 * docs/watch/index.html) — those run in the browser and can't import this.
 */

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

// A few independent STUN endpoints for robust server-reflexive discovery. IPv6
// host candidates are gathered automatically by the WebRTC stack (no NAT there),
// so this list only matters for IPv4 NAT traversal.
export const STUN_SERVERS: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

// No public TURN is bundled. The free openrelay.metered.ca project that used to
// live here is defunct — a dead TURN entry only produces failed STUN-binding log
// spam without helping. The rare both-peers-symmetric-NAT case is covered by
// peer-relay; a user who still needs a relay can add their OWN (self-hosted coturn
// or a managed key) in settings, which is merged in at connect time via the helper
// below — so there is no bundled TURN_SERVERS list anymore.

// Build the ICE entry for a user-supplied TURN relay (settings.customTurn*).
// Returns [] when none is configured. Pure — safe to import in the hidden-window
// engines. One side configuring TURN is enough to relay (its relay address is
// publicly reachable), so this is the zero-infra ladder's optional last rung.
export function customTurnToIce(url?: string, username?: string, credential?: string): IceServer[] {
  const u = (url || '').trim();
  if (!u) return [];
  const s: IceServer = { urls: u };
  if (username) s.username = username;
  if (credential) s.credential = credential;
  return [s];
}

// Rendezvous trackers (WebRTC signaling only). They broker the WebRTC handshake;
// they never carry file bytes or any plaintext. We announce to all of them and
// bittorrent-tracker tolerates any that are down, so multiple independent
// operators give resilience without any of them being load-bearing.
//
// HAVVN_ROOM_TRACKERS (comma-separated URLs, e.g. ws://127.0.0.1:8009) replaces
// the whole set — a dev/test affordance in the TH_INSTANCE spirit: two local
// instances can rendezvous against a local bittorrent-tracker with no public
// infrastructure in the loop.
const TRACKER_OVERRIDE = (typeof process !== 'undefined' && process.env.HAVVN_ROOM_TRACKERS || '').trim();
export const RENDEZVOUS_TRACKERS: string[] = TRACKER_OVERRIDE
  ? TRACKER_OVERRIDE.split(',').map((s) => s.trim()).filter(Boolean)
  : [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.files.fm:7073/announce',
  ];
