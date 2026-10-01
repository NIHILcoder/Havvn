import { EventEmitter } from 'events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), destroyAgent: vi.fn(), fetch: vi.fn() }));
vi.mock('https', () => ({ default: { get: mocks.get, Agent: class { destroy = mocks.destroyAgent; } } }));
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }));
import { readHttpsText, getDirectPublicIp, getSystemPublicIp, fetchIpGeo } from './ip-probe';

let request: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
let callback: (res: EventEmitter & { statusCode: number; resume: ReturnType<typeof vi.fn> }) => void;
function respond(status: number, text: string, end = true) {
  const res = Object.assign(new EventEmitter(), { statusCode: status, resume: vi.fn() });
  callback(res); res.emit('data', Buffer.from(text)); if (end) res.emit('end');
  return res;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  mocks.get.mockImplementation((_url, _options, cb) => { callback = cb; return request; });
});
afterEach(() => vi.useRealTimers());

it('rejects an HTTP error body rather than displaying it as an IP', async () => {
  const p = getDirectPublicIp(); respond(503, 'Service Unavailable');
  expect(await p).toBeUndefined(); expect(request.destroy).toHaveBeenCalledOnce();
});
it.each(['blocked', '<html>challenge</html>', '999.1.1.1', ''])('rejects invalid IP response %s', async text => {
  const p = getDirectPublicIp(); respond(200, text); expect(await p).toBeUndefined();
});
it('accepts IPv4 and IPv6', async () => {
  let p = getDirectPublicIp(); respond(200, ' 203.0.113.1\n'); expect(await p).toBe('203.0.113.1');
  p = getDirectPublicIp(); respond(200, '2001:db8::1'); expect(await p).toBe('2001:db8::1');
});
it('aborts the request and agent on a whole-request deadline', async () => {
  const p = readHttpsText('https://api.ipify.org'); const assertion = expect(p).rejects.toThrow('timed out');
  respond(200, 'partial', false); await vi.advanceTimersByTimeAsync(5000); await assertion;
  expect(request.destroy).toHaveBeenCalledOnce(); expect(mocks.destroyAgent).toHaveBeenCalledOnce();
});
it('limits streamed response size and closes the request', async () => {
  const p = readHttpsText('https://api.ipify.org'); const assertion = expect(p).rejects.toThrow('too large');
  respond(200, 'x'.repeat(16385)); await assertion; expect(request.destroy).toHaveBeenCalledOnce();
});
it('handles a truncated/error response', async () => {
  const p = getDirectPublicIp(); const res = respond(200, '203.0.', false); res.emit('aborted');
  expect(await p).toBeUndefined();
});
it('validates geo input, fields and status, without using ISP text as a VPN signal', async () => {
  expect(await fetchIpGeo('../../')).toEqual({}); expect(mocks.get).not.toHaveBeenCalled();
  const p = fetchIpGeo('203.0.113.1'); respond(200, JSON.stringify({ country: 'DE', city: 123, org: 'Cloud Hosting', region: [] }));
  expect(await p).toEqual({ country: 'DE', city: undefined, org: 'Cloud Hosting', region: undefined });
});
it('bounds and validates the system-proxy web result as well', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('203.0.113.2'));
  expect(await getSystemPublicIp()).toBe('203.0.113.2');
  mocks.fetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
  expect(await getSystemPublicIp()).toBeUndefined();
  mocks.fetch.mockResolvedValueOnce(new Response('x'.repeat(1025)));
  expect(await getSystemPublicIp()).toBeUndefined();
});
