/**
 * TransmissionRpc — minimal typed client for transmission-daemon's JSON-RPC
 * (transmission docs/rpc-spec.md). Plain fetch, no dependencies, no Electron
 * imports — must run both in the torrent-host utilityProcess and in plain Node
 * (the spike harness).
 *
 * Protocol: POST /transmission/rpc with {method, arguments}. The daemon
 * CSRF-guards the endpoint with X-Transmission-Session-Id: the first request
 * (and any request after a daemon restart) gets 409 + the current id in the
 * response header; adopt it and retry the SAME request once.
 */

export interface TransmissionRpcOptions {
  port: number;
  host?: string;      // default 127.0.0.1 — the daemon is ours, never remote
  username?: string;  // Basic auth (rpc-authentication-required)
  password?: string;
  timeoutMs?: number; // per-call, default 30s
}

export class TransmissionRpcError extends Error {
  constructor(message: string, readonly method: string) {
    super(`transmission rpc ${method}: ${message}`);
    this.name = 'TransmissionRpcError';
  }
}

/** torrent-get `status` values (tr_torrent_activity). */
export enum TrStatus {
  Stopped = 0,
  CheckWait = 1,
  Checking = 2,
  DownloadWait = 3,
  Downloading = 4,
  SeedWait = 5,
  Seeding = 6,
}

export interface TrFile { name: string; length: number; bytesCompleted: number }
export interface TrFileStat { wanted: boolean; priority: number; bytesCompleted: number }
export interface TrPeer {
  address: string;
  port: number;
  clientName: string;
  isUTP: boolean;
  isEncrypted: boolean;
  isIncoming: boolean;
  rateToClient: number; // B/s we download from this peer
  rateToPeer: number;   // B/s we upload to this peer
  progress: number;     // 0..1
  flagStr: string;
}
export interface TrTrackerStat {
  id: number;
  host: string;
  announce: string;
  lastAnnounceResult: string;
  lastAnnounceSucceeded: boolean;
  seederCount: number;
  leecherCount: number;
}

/** The torrent-get fields the app consumes. Request only what you read. */
export interface TrTorrent {
  id: number;
  hashString: string;
  name: string;
  status: TrStatus;
  percentDone: number;      // 0..1 of WANTED bytes
  recheckProgress: number;  // 0..1 while status is Checking
  totalSize: number;
  sizeWhenDone: number;
  leftUntilDone: number;
  rateDownload: number;     // B/s
  rateUpload: number;       // B/s
  downloadedEver: number;
  uploadedEver: number;
  uploadRatio: number;
  eta: number;              // seconds, -1 unknown, -2 unknown/none
  peersConnected: number;
  peersSendingToUs: number;
  peersGettingFromUs: number;
  error: number;            // 0 ok, 1/2 tracker warn/error, 3 local error
  errorString: string;
  isFinished: boolean;
  downloadDir: string;
  magnetLink: string;
  metadataPercentComplete: number; // <1 while a magnet is still fetching metainfo
  files?: TrFile[];
  fileStats?: TrFileStat[];
  peers?: TrPeer[];
  trackerStats?: TrTrackerStat[];
  pieceCount?: number;
  pieceSize?: number;
  pieces?: string; // base64 bitfield
}

export type TrIds = number | string | Array<number | string>; // id | hashString

export interface TrAddResult {
  id: number;
  hashString: string;
  name: string;
  duplicate: boolean;
}

interface RpcEnvelope<T> { result: string; arguments: T }

export class TransmissionRpc {
  private sessionId = '';
  private readonly url: string;
  private readonly auth?: string;
  private readonly timeoutMs: number;

  constructor(opts: TransmissionRpcOptions) {
    this.url = `http://${opts.host ?? '127.0.0.1'}:${opts.port}/transmission/rpc`;
    if (opts.username !== undefined) {
      this.auth = 'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64');
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async call<T = Record<string, never>>(method: string, args?: Record<string, unknown>): Promise<T> {
    let res = await this.post(method, args);
    if (res.status === 409) {
      // CSRF handshake: adopt the daemon's session id and replay once.
      this.sessionId = res.headers.get('x-transmission-session-id') ?? '';
      if (!this.sessionId) throw new TransmissionRpcError('409 without session id header', method);
      res = await this.post(method, args);
    }
    if (res.status === 401) throw new TransmissionRpcError('unauthorized (rpc credentials)', method);
    if (!res.ok) throw new TransmissionRpcError(`http ${res.status}`, method);
    const body = (await res.json()) as RpcEnvelope<T>;
    if (body.result !== 'success') throw new TransmissionRpcError(body.result, method);
    return body.arguments;
  }

  private post(method: string, args?: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.sessionId) headers['x-transmission-session-id'] = this.sessionId;
    if (this.auth) headers['authorization'] = this.auth;
    return fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args ? { method, arguments: args } : { method }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  // ── Session ────────────────────────────────────────────────────────────────
  sessionGet(): Promise<Record<string, unknown>> { return this.call('session-get'); }
  sessionSet(args: Record<string, unknown>): Promise<void> { return this.call('session-set', args).then(() => undefined); }
  sessionStats(): Promise<Record<string, unknown>> { return this.call('session-stats'); }
  /** Ask the daemon to persist state and exit (clean sidecar shutdown). */
  sessionClose(): Promise<void> { return this.call('session-close').then(() => undefined); }
  portTest(): Promise<{ 'port-is-open': boolean }> { return this.call('port-test'); }
  freeSpace(path: string): Promise<{ path: string; 'size-bytes': number }> { return this.call('free-space', { path }); }
  blocklistUpdate(): Promise<{ 'blocklist-size': number }> { return this.call('blocklist-update'); }

  // ── Torrents ───────────────────────────────────────────────────────────────
  /** Add by magnet/URL (`filename`) or raw .torrent contents (`metainfo`). */
  async torrentAdd(source: { filename?: string; metainfo?: Buffer; paused?: boolean; downloadDir?: string }): Promise<TrAddResult> {
    const args: Record<string, unknown> = {};
    if (source.filename !== undefined) args['filename'] = source.filename;
    if (source.metainfo !== undefined) args['metainfo'] = source.metainfo.toString('base64');
    if (source.paused !== undefined) args['paused'] = source.paused;
    if (source.downloadDir !== undefined) args['download-dir'] = source.downloadDir;
    const res = await this.call<{ 'torrent-added'?: TrAddResult; 'torrent-duplicate'?: TrAddResult }>('torrent-add', args);
    const added = res['torrent-added'];
    const dup = res['torrent-duplicate'];
    const t = added ?? dup;
    if (!t) throw new TransmissionRpcError('no torrent in response', 'torrent-add');
    return { ...t, duplicate: !!dup };
  }

  async torrentGet(fields: Array<keyof TrTorrent | string>, ids?: TrIds): Promise<TrTorrent[]> {
    const args: Record<string, unknown> = { fields };
    if (ids !== undefined) args['ids'] = ids;
    const res = await this.call<{ torrents: TrTorrent[] }>('torrent-get', args);
    return res.torrents;
  }

  torrentStop(ids: TrIds): Promise<void> { return this.call('torrent-stop', { ids }).then(() => undefined); }
  /** start-now skips the download queue — what a user-initiated resume expects. */
  torrentStartNow(ids: TrIds): Promise<void> { return this.call('torrent-start-now', { ids }).then(() => undefined); }
  torrentVerify(ids: TrIds): Promise<void> { return this.call('torrent-verify', { ids }).then(() => undefined); }
  torrentRemove(ids: TrIds, deleteLocalData: boolean): Promise<void> {
    return this.call('torrent-remove', { ids, 'delete-local-data': deleteLocalData }).then(() => undefined);
  }
  /** Mutable per-torrent properties: files-wanted/unwanted, priority-*, limits, trackers… */
  torrentSet(ids: TrIds, args: Record<string, unknown>): Promise<void> {
    return this.call('torrent-set', { ...args, ids }).then(() => undefined);
  }
}
