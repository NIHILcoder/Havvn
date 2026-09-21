import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fromProject = createRequire(path.join(process.cwd(), 'package.json'));
const fromCast = createRequire(fromProject.resolve('chromecast-api'));
const { parseString } = fromCast('xml2js');
function parse(xml: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // Same callback API and options as chromecast-api/lib/client.js.
    parseString(xml, { explicitArray: false, explicitRoot: false }, (err: Error | null, result: unknown) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

describe('Chromecast device XML parser', () => {
  it('preserves the device description shape used by discovery', async () => {
    const result = await parse('<root><device><friendlyName>Living &amp; TV</friendlyName><UDN>uuid:cast-1</UDN><modelName>Chromecast</modelName></device></root>');
    expect(result.device).toEqual({ friendlyName: 'Living & TV', UDN: 'uuid:cast-1', modelName: 'Chromecast' });
  });

  it('treats __proto__ as data without changing the parsed object prototype', async () => {
    const result = await parse('<root><device><__proto__><injected>true</injected></__proto__><friendlyName>TV</friendlyName></device></root>');
    expect(Object.getPrototypeOf(result.device)).toBe(Object.prototype);
    expect(Object.hasOwn(result.device, '__proto__')).toBe(true);
    expect(result.device.injected).toBeUndefined();
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });
});
