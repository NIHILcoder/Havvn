import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const trackerRequire = createRequire(path.join(root, 'node_modules/bittorrent-tracker/package.json'));
const ssdpRequire = createRequire(path.join(root, 'node_modules/node-ssdp/package.json'));

for (const [consumer, requireFrom] of [['tracker', trackerRequire], ['SSDP', ssdpRequire]] as const) {
  const ip = requireFrom('ip');
  describe(`${consumer} installed IP implementation`, () => {
    it.each(['127.0.0.1', '127.1', '127.255.255.255', '10.0.0.1', '172.16.0.1',
      '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1',
      'fe80::1', 'fc00::1'])('does not classify %s as public', address => {
      expect(ip.isPublic(address)).toBe(false);
    });

    it.each(['0127.0.0.1', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1'])('rejects ambiguous notation %s', address => {
      expect(() => ip.isPublic(address)).toThrow();
    });

    it('retains public address classification and binary conversion', () => {
      expect(ip.isPublic('8.8.8.8')).toBe(true);
      expect(ip.isPublic('2606:4700:4700::1111')).toBe(true);
      expect(ip.toString(Buffer.from([192, 168, 1, 2]))).toBe('192.168.1.2');
      expect(ip.toString(0xc0a80102)).toBe('192.168.1.2');
      expect(isIP(ip.address())).toBe(4);
    });
  });
}

it('decodes a UDP tracker announce with an explicit IPv4 address through the real ESM parser', async () => {
  const url = pathToFileURL(path.join(root, 'node_modules/bittorrent-tracker/lib/server/parse-udp.js')).href;
  const { default: parse } = await import(url);
  const packet = Buffer.alloc(98);
  packet.writeBigUInt64BE(0x41727101980n, 0);
  packet.writeUInt32BE(1, 8); // ANNOUNCE
  packet.writeUInt32BE(42, 12);
  packet.fill(1, 16, 36); // info hash
  packet.fill(2, 36, 56); // peer id
  packet.writeUInt32BE(2, 80); // started
  packet.writeUInt32BE(0xc0a80102, 84);
  packet.writeUInt32BE(10, 92);
  packet.writeUInt16BE(51413, 96);
  expect(parse(packet, { address: '127.0.0.1', port: 10000 })).toMatchObject({
    ip: '192.168.1.2', port: 51413, addr: '192.168.1.2:51413', transactionId: 42,
  });
  packet.writeUInt32BE(0, 84);
  expect(parse(packet, { address: '127.0.0.1', port: 10000 }).ip).toBe('127.0.0.1');
});

it('initializes the real SSDP location using the replacement without starting discovery', () => {
  const { Client } = ssdpRequire('./');
  const client = new Client();
  expect(isIP(new URL(client._location).hostname)).toBe(4);
  expect(new URL(client._location).pathname).toBe('/upnp/desc.html');
  client.stop();
});
