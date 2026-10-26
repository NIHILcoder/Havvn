import { expect, it, vi } from 'vitest';
import { deferTorrentDiscovery } from './deferred-discovery';

it('verifies offline and starts discovery only once after activation', () => {
  const complete = vi.fn();
  const torrent = { ready: false, destroyed: false, done: false,
    discovery: null as { complete(): void; destroy(cb: () => void): void } | null,
    _startDiscovery: vi.fn(function () { torrent.discovery = { complete, destroy: cb => cb() }; }) };
  const original = torrent._startDiscovery;
  const activate = deferTorrentDiscovery(torrent);
  torrent._startDiscovery(); torrent.ready = true; torrent.done = true;
  torrent.discovery!.complete();
  expect(original).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  activate(); activate();
  expect(original).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
});

it('can close a paused verification without starting discovery', () => {
  const torrent = { ready: true, destroyed: false, done: false,
    discovery: null as { complete(): void; destroy(cb: () => void): void } | null,
    _startDiscovery: vi.fn() };
  const original = torrent._startDiscovery, activate = deferTorrentDiscovery(torrent);
  torrent._startDiscovery(); const closed = vi.fn(); torrent.discovery!.destroy(closed);
  torrent.destroyed = true; activate();
  expect(closed).toHaveBeenCalledOnce(); expect(original).not.toHaveBeenCalled();
});
