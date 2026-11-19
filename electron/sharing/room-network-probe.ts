import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { RoomEndpointProbe } from '../../shared/room-connection-help';

/** Probe only manager-selected rendezvous URLs. No announce, room key, ID or peer data. */
export function probeRoomEndpoint(target: string, index: number, signal: AbortSignal, timeoutMs = 6000): Promise<RoomEndpointProbe> {
  const result: RoomEndpointProbe = { index, dns: 'unknown', tcp: 'unknown', tls: 'unknown', websocket: 'unknown' };
  return new Promise(resolve => {
    let url: URL;
    try { url = new URL(target); if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw Error(); }
    catch { result.websocket = 'failed'; resolve(result); return; }
    const secure = url.protocol === 'wss:', hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!secure) result.tls = 'skipped';
    if (isIP(hostname)) result.dns = 'skipped';
    if (signal.aborted) { resolve(result); return; }
    let done = false;
    const key = randomBytes(16).toString('base64');
    const request = (secure ? https : http).request({ hostname, port: url.port || (secure ? 443 : 80), path: url.pathname + url.search,
      method: 'GET', agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    const finish = () => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); request.destroy(); resolve(result); };
    const fail = () => {
      if (Object.values(result).includes('failed')) { finish(); return; }
      if (result.dns === 'unknown') result.dns = 'failed';
      else if (result.tcp === 'unknown') result.tcp = 'failed';
      else if (secure && result.tls === 'unknown') result.tls = 'failed';
      else result.websocket = 'failed';
      finish();
    };
    const abort = () => finish();
    const timer = setTimeout(fail, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    request.on('socket', socket => {
      socket.once('lookup', error => { if (!done) result.dns = error ? 'failed' : 'ok'; });
      socket.once('connect', () => { if (!done) result.tcp = 'ok'; });
      socket.once('secureConnect', () => { if (!done) result.tls = 'ok'; });
    });
    request.on('upgrade', (response, socket) => {
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const upgrade = response.headers.upgrade?.toLowerCase() === 'websocket';
      const connection = response.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade');
      result.websocket = response.statusCode === 101 && upgrade && connection && response.headers['sec-websocket-accept'] === accept ? 'ok' : 'failed';
      socket.destroy(); finish();
    });
    request.on('response', response => { response.destroy(); result.websocket = 'failed'; finish(); });
    request.on('error', () => { if (!done) fail(); });
    request.end();
  });
}
