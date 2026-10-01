import https from 'https';
import { isIP } from 'net';

/** Deadline covers DNS, connection and response body; failure closes the socket. */
export function readHttpsText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let request: ReturnType<typeof https.get> | undefined;
    const agent = new https.Agent(); // no automatic environment/system proxy
    const finish = (error?: Error, text = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      request?.destroy();
      agent.destroy();
      if (error) reject(error); else resolve(text);
    };
    const deadline = setTimeout(() => finish(new Error('IP lookup timed out')), 5000);
    try {
      const req = https.get(url, { agent, headers: { Accept: 'application/json', 'User-Agent': 'Havvn' } }, res => {
        if (res.statusCode !== 200) { res.resume(); finish(new Error(`IP lookup HTTP ${res.statusCode}`)); return; }
        let data = '';
        let size = 0;
        res.on('data', chunk => {
          size += Buffer.byteLength(chunk);
          if (size > 16 * 1024) { finish(new Error('IP lookup response too large')); return; }
          data += chunk;
        });
        res.on('end', () => finish(undefined, data));
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('IP lookup response aborted')));
      });
      request = req;
      req.on('error', error => finish(error));
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function getDirectPublicIp(): Promise<string | undefined> {
  try {
    const ip = (await readHttpsText('https://api.ipify.org')).trim();
    return isIP(ip) ? ip : undefined;
  } catch { return undefined; }
}

export async function fetchIpGeo(ip: string): Promise<{ country?: string; region?: string; city?: string; org?: string }> {
  if (!isIP(ip)) return {};
  try {
    const data = JSON.parse(await readHttpsText(`https://ipinfo.io/${encodeURIComponent(ip)}/json`));
    const field = (name: string) => typeof data[name] === 'string' ? data[name].slice(0, 200) : undefined;
    return { country: /^[A-Z]{2}$/.test(data.country) ? data.country : undefined, region: field('region'), city: field('city'), org: field('org') };
  } catch { return {}; }
}

/** Chromium uses the system proxy; this result is a web exit, not a torrent exit. */
export async function getSystemPublicIp(): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const { net } = await import('electron');
    const response = await net.fetch('https://api.ipify.org', { signal: controller.signal, redirect: 'error' });
    if (response.status !== 200) { await response.body?.cancel(); return undefined; }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    let size = 0;
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024) { await reader.cancel(); return undefined; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const ip = text.trim();
    return isIP(ip) ? ip : undefined;
  } catch { return undefined; } finally { clearTimeout(timeout); }
}
