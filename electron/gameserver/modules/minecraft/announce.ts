/**
 * Minecraft LAN discovery — the packet that makes a server appear in the
 * "Scanning for games on your local network" list.
 *
 * WHY THIS EXISTS AT ALL
 * A DEDICATED Minecraft server never sends this packet. Only a singleplayer
 * world "opened to LAN" does. So without help, a server running behind Havvn's
 * virtual LAN is reachable but INVISIBLE: every member has to be told a
 * 100.x.y.z address and type it in by hand, which throws away most of the value
 * of having a tunnel at all.
 *
 * Havvn sends the announcement on the server's behalf, out of the host's Wintun
 * adapter. The tunnel already replicates multicast between members — the thing
 * an L3 tunnel does not give you for free and the reason Minecraft LAN worlds
 * work here — so every member's client picks the server up on its own. Open the
 * game, and it is in the list. No addresses, no ports, no instructions.
 *
 * The wire format is fixed by the vanilla client:
 *   destination 224.0.2.60:4445 (UDP multicast)
 *   payload     [MOTD]<motd>[/MOTD][AD]<port>[/AD]
 */
import type { AnnouncePlan } from '../../../../shared/gameserver-types';

export const MC_ANNOUNCE_HOST = '224.0.2.60';
export const MC_ANNOUNCE_PORT = 4445;

/** The vanilla client re-broadcasts every 1.5 s; matching it means a client that
 *  starts scanning at any moment sees the server within about that long. */
export const MC_ANNOUNCE_INTERVAL_MS = 1500;

/** Keep the MOTD short. The client renders it in a narrow list row, and a huge
 *  payload buys nothing. */
const MAX_MOTD = 64;

const DEFAULT_MOTD = 'Havvn server';

/**
 * Build the payload.
 *
 * The sanitising is not cosmetic. The format has no escaping whatsoever, so a
 * MOTD containing `[/MOTD]` truncates the field and shifts everything after it —
 * at best a mangled list entry, at worst a client-side parse that reads a port
 * out of attacker-chosen text. Since a MOTD is user-supplied (and, once presets
 * are shareable, potentially supplied by another room member), the bracket
 * keywords and all control characters are removed before they reach the wire.
 */
export function buildAnnouncePayload(motd: string, port: number): Buffer {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid announce port: ${port}`);
  }
  const clean = String(motd ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\[\/?(MOTD|AD)\]/gi, (m) => m.replace(/[[\]/]/g, ''))
    .replace(/[[\]]/g, '')
    .trim()
    .slice(0, MAX_MOTD)
    .trim();
  const text = clean || DEFAULT_MOTD;
  return Buffer.from(`[MOTD]${text}[/MOTD][AD]${port}[/AD]`, 'utf8');
}

export function minecraftAnnouncePlan(motd: string, port: number): AnnouncePlan {
  return {
    host: MC_ANNOUNCE_HOST,
    port: MC_ANNOUNCE_PORT,
    payload: buildAnnouncePayload(motd, port),
    intervalMs: MC_ANNOUNCE_INTERVAL_MS,
    multicast: true,
  };
}
