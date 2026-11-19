import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({}) }));
vi.mock('../lan/lan-net-registry', () => ({ lanSubnets: { list: () => [] } }));
import { CastServer } from './cast-server';

let server: CastServer | undefined, directory: string | undefined;
afterEach(async () => {
  server?.destroy(); server = undefined;
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});
describe('untrusted image responses', () => {
  it('sandboxes SVG documents and keeps the token out of referrers', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'havvn-cast-security-'));
    const file = path.join(directory, 'peer.svg');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__peerScriptRan=true"><script>window.__peerScriptRan=true</script><rect width="10" height="10"/></svg>';
    await fs.writeFile(file, svg);
    server = new CastServer(() => null, () => null);
    const { url } = await server.publishImage(file);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toMatch(/(?:^|; )sandbox(?:;|$)/);
    expect(response.headers.get('content-security-policy')).not.toContain('allow-scripts');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(svg);
    const unauthorized = new URL(url); unauthorized.searchParams.delete('k');
    expect((await fetch(unauthorized)).status).toBe(403);
    const otherFile = new URL(url); otherFile.pathname = '/image/not-published/0';
    expect((await fetch(otherFile)).status).toBe(404);
  });
});
