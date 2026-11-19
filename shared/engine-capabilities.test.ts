import { expect, it } from 'vitest';
import { engineCapabilities, readEngineCapabilities } from './engine-capabilities';

it('separates actual implementation support for both engines', () => {
  const native = engineCapabilities('native'), classic = engineCapabilities('webtorrent');
  expect(native.features.boundedEpisodePrefetch).toEqual({ supported: false, reason: 'file-selection-only' });
  expect(classic.features.boundedEpisodePrefetch.supported).toBe(true);
  expect(native.features.autoMoveCompleted.supported).toBe(false); expect(classic.features.autoMoveCompleted.supported).toBe(true);
  expect(native.features.dnsOverHttps.supported).toBe(false); expect(classic.features.dnsOverHttps.supported).toBe(true);
  expect(native.features.vpnInterfaceBinding.supported).toBe(true); expect(classic.features.vpnInterfaceBinding.supported).toBe(false);
});
it('does not infer support from an engine name or accept a future or incomplete reply', () => {
  for (const reply of [null, { engine: 'webtorrent' }, { ...engineCapabilities('webtorrent'), schema: 2 }, { schema: 1, engine: 'native', features: {} }]) expect(readEngineCapabilities(reply)).toBeNull();
  const reply = engineCapabilities('native'); Object.assign(reply.features.boundedEpisodePrefetch, { supported: 'true' });
  expect(readEngineCapabilities(reply)).toBeNull();
});
it('projects replies without exposing unrelated runtime or configuration data', () => {
  const reply = { ...engineCapabilities('native'), privateConfig: 'secret' };
  expect(JSON.stringify(readEngineCapabilities(reply))).not.toContain('secret');
});
