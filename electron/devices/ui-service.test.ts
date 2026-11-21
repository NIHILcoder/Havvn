import { afterEach, expect, it } from 'vitest';
import { DeviceUiService } from './ui-service';
import { emptyDeviceUiConfig, validateDeviceUiConfig } from './ui-config';
import { deviceHost } from './network';
import { DeviceVault } from './vault';
import { memoryDeviceStorage } from '../../research/device-pairing/vault-fixture';
import { targetFixture, dataPair } from '../../research/device-pairing/data-fixture';
import { captureDeviceLocal } from '../../shared/device-capture';
const cleanup: DeviceUiService[] = [];
afterEach(async () => { for (const s of cleanup.splice(0).reverse()) await s.close(); });
function fixture(seed: string) {
  const storage = memoryDeviceStorage(seed), values = new Map<string, string>();
  let config = emptyDeviceUiConfig(), exists = false, opens = 0;
  let target: ReturnType<typeof targetFixture>;
  const service = new DeviceUiService({
    config: { read: () => structuredClone(config), write: c => { config = structuredClone(c); } },
    hasVault: () => exists,
    open: async initialize => { opens++; exists = true; return initialize ? DeviceVault.initialize(storage.io()) : DeviceVault.open(storage.io()); },
    archive: async () => { exists = false; },
    renderer: vault => {
      target = targetFixture(vault);
      target.storage.getItem = key => values.get(key) ?? null;
      target.storage.setItem = (key, value) => { values.set(key, value); };
      target.storage.removeItem = key => { values.delete(key); };
      return { ...target.target, capture: async scopes => captureDeviceLocal(target.storage, scopes, target.context, () => '1'.repeat(32), () => {}), close: () => {} };
    },
    refresh: async () => {}, addresses: () => ['127.0.0.1'], changed: () => {},
  });
  cleanup.push(service);
  return { service, values, opens: () => opens };
}
async function until(check: () => boolean) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 20)); } }
it('does not open a vault or listener when disabled by default', async () => {
  const f = fixture('a'.repeat(64)); await f.service.start();
  expect(f.opens()).toBe(0); expect(f.service.state().status).toBe('off');
});
it('does not replay an inherited backend journal while the first UI data consent is absent', async () => {
  const f = await dataPair();
  f.ta.values.set('language', 'ru'); const op = await f.ra.publish('preferences', 'language', 'ru');
  f.tb.faults.after = 0; await expect(f.rb.receive(op)).rejects.toThrow('write'); f.tb.faults.after = Infinity;
  f.tb.values.set('density', 'compact');
  const config = { ...emptyDeviceUiConfig(), enabled: true, listen: { host: '127.0.0.1', port: 0 } };
  const service = new DeviceUiService({
    config: { read: () => config, write: () => {} }, hasVault: () => true, open: async () => f.b, archive: async () => {},
    renderer: () => ({ ...f.tb.target, close: () => {}, capture: async () => ({ records: [{ scope: 'preferences', recordId: 'density', value: 'compact', deleted: false }], issues: [] }) }),
    refresh: async () => {}, addresses: () => ['127.0.0.1'], changed: () => {},
  });
  try {
    await service.start();
    expect(f.tb.values.has('language')).toBe(false);
    expect(f.b.pendingDataJob()).not.toBeNull();
    expect(service.state().approved).toBe(false);
  } finally { await service.close(); await f.close(); }
});
it.each(['0.0.0.0', '8.8.8.8', 'localhost', '169.254.1.1', '::1', '172.32.0.1'])('rejects endpoint %s', host => {
  expect(() => deviceHost(host)).toThrow('invalid');
});
it.each(['127.0.0.1', '10.1.2.3', '192.168.10.4', '172.16.2.3', '172.31.255.254'])('accepts explicit local IPv4 %s', host => { expect(deviceHost(host)).toBe(host); });
it('rejects unknown plaintext config fields and public routes', () => {
  expect(() => validateDeviceUiConfig({ ...emptyDeviceUiConfig(), token: 'secret' })).toThrow('invalid');
  expect(() => validateDeviceUiConfig({ ...emptyDeviceUiConfig(), remote: { host: '1.1.1.1', port: 443 } })).toThrow('invalid');
});
it('pairs through two consent prompts, gates exchange separately, reconnects and revokes offline', async () => {
  const a = fixture('a'.repeat(64)), b = fixture('b'.repeat(64));
  a.values.set('language', 'ru');
  for (const f of [a, b]) {
    await f.service.command({ kind: 'enable', enabled: true });
    await f.service.command({ kind: 'configure', listen: { host: '127.0.0.1', port: 0 }, remote: null, scopes: ['preferences'] });
  }
  const invite = await a.service.command({ kind: 'invite' }); expect(invite.invitation).toBeTruthy();
  expect(invite.invitationExpiresAt).toBe(JSON.parse(invite.invitation!).expiresAt); expect(invite.invitationExpiresAt).toBeGreaterThan(Date.now());
  await b.service.command({ kind: 'join', text: invite.invitation! });
  await until(() => !!b.service.state().confirmation);
  expect(b.service.state().confirmation!.peer).toBe(a.service.state().self);
  await b.service.command({ kind: 'confirm', id: b.service.state().confirmation!.id, accept: true });
  await until(() => !!a.service.state().confirmation);
  await a.service.command({ kind: 'confirm', id: a.service.state().confirmation!.id, accept: true });
  await until(() => a.service.state().status === 'online' && b.service.state().status === 'online');
  expect(a.service.state().approved).toBe(false); expect(b.values.has('language')).toBe(false);
  await a.service.command({ kind: 'approve', grant: a.service.state().grant! });
  await until(() => b.service.state().pending > 0);
  expect(b.values.has('language')).toBe(false);
  await b.service.command({ kind: 'approve', grant: b.service.state().grant! });
  await until(() => b.values.get('language') === 'ru' && a.service.state().outbox === 0);
  await b.service.command({ kind: 'reconnect' });
  await until(() => b.service.state().status === 'online');
  expect(b.service.state().approved).toBe(true);
  await b.service.command({ kind: 'enable', enabled: false });
  await a.service.command({ kind: 'revoke' });
  expect(a.service.state().status).toBe('revoked'); expect(a.service.state().outbox).toBe(0);
});
