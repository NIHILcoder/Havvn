/**
 * Default public BitTorrent trackers for newly-created torrents.
 *
 * Kept in its own tiny module (no WebTorrent import) so the MAIN process can read
 * the list — e.g. the Create-Torrent UI's "default trackers" — without pulling in
 * creator.ts, which imports WebTorrent. (Torrent creation itself runs in the host.)
 */

export const DEFAULT_TRACKERS: string[][] = [
  ['udp://tracker.opentrackr.org:1337/announce'],
  ['udp://open.tracker.cl:1337/announce'],
  ['udp://tracker.openbittorrent.com:6969/announce'],
  ['udp://open.stealth.si:80/announce'],
  ['udp://tracker.torrent.eu.org:451/announce'],
  ['udp://exodus.desync.com:6969/announce'],
  ['udp://tracker.moeking.me:6969/announce'],
  ['udp://explodie.org:6969/announce'],
  ['udp://tracker.theoks.net:6969/announce'],
  ['udp://tracker1.bt.moack.co.kr:80/announce'],
];

export function getDefaultTrackers(): string[][] {
  return DEFAULT_TRACKERS;
}
