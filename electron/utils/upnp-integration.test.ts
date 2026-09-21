import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import UpnpClient from '@silentbot1/nat-api/lib/upnp/index.js';
// This untyped dependency is exercised here at runtime using its real parser.
// @ts-expect-error upstream does not ship declarations for Device
import Device from '@silentbot1/nat-api/lib/upnp/device.js';

let descriptionUrl = '';
let failMapping = false;
const requests: Array<{ action: string; body: string }> = [];
// Replace only network discovery: SOAP HTTP, XML parsing and the actual UPnP
// client remain real. No traffic is sent to the user's router during this test.
function createClient(): UpnpClient {
  // Do not invoke the constructor, which opens multicast sockets immediately.
  return Object.assign(Object.create(UpnpClient.prototype), {
    _destroyed: false, permanentFallback: false, timeout: 1800,
    ssdp: {
      async search() {
        return { device: new Device({ url: descriptionUrl }), address: '192.168.1.20' };
      },
      async destroy() {},
    },
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/description.xml') {
    res.end(`<root><device><serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
      <controlURL>/control</controlURL><SCPDURL>/service.xml</SCPDURL>
      </service></serviceList></device></root>`);
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  const action = String(req.headers.soapaction).split('#')[1]?.replace('"', '') || '';
  requests.push({ action, body });
  if (failMapping && action === 'AddPortMapping') {
    res.writeHead(403).end('Refused');
    return;
  }
  res.setHeader('Content-Type', 'text/xml');
  res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
    ${action === 'GetExternalIPAddress' ? '<NewExternalIPAddress>203.0.113.9</NewExternalIPAddress>' : ''}
    </u:${action}Response></s:Body></s:Envelope>`);
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  descriptionUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/description.xml`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('UPnP replacement with a loopback router', () => {
  it('maps TCP with a finite lease, reads the external address and removes the mapping', async () => {
    const client = createClient();
    try {
      await client.portMapping({ public: 51413, private: 51413, protocol: 'tcp', ttl: 3600, description: 'Havvn' });
      expect(await client.externalIp()).toBe('203.0.113.9');
      await client.portUnmapping({ public: 51413, protocol: 'tcp' });
      expect(requests.map(r => r.action)).toEqual(['AddPortMapping', 'GetExternalIPAddress', 'DeletePortMapping']);
      expect(requests[0].body).toContain('<NewProtocol>TCP</NewProtocol>');
      expect(requests[0].body).toContain('<NewInternalClient>192.168.1.20</NewInternalClient>');
      expect(requests[0].body).toContain('<NewLeaseDuration>3600</NewLeaseDuration>');
      expect(requests[0].body).toContain('<NewExternalPort>51413</NewExternalPort>');
    } finally { await client.destroy(); }
  });

  it('rejects a refused mapping and cannot be reused after destruction', async () => {
    const client = createClient();
    failMapping = true;
    try { await expect(client.portMapping({ public: 51413, protocol: 'tcp' })).rejects.toThrow(); }
    finally { failMapping = false; await client.destroy(); }
    await expect(client.externalIp()).rejects.toThrow('destroyed');
  });
});
