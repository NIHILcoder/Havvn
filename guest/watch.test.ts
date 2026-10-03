import { afterEach, expect, it, vi } from 'vitest';
import { playMagnet } from './watch';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('ignores late torrent/blob callbacks after closing and releases owned blob URLs', () => {
  let ready: (t: { files: { name: string; getBlobURL(cb: (err: Error | null, url: string) => void): void }[] }) => void;
  let blob: (err: Error | null, url: string) => void;
  const destroy = vi.fn(), remove = vi.fn(), render = vi.fn();
  vi.stubGlobal('WebTorrent', class { add(_m: string, _o: unknown, cb: typeof ready) { ready = cb; } destroy = destroy; remove = remove; });
  const media = { src: '' } as HTMLMediaElement, revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const file = { name: 'film.mp4', getBlobURL(cb: typeof blob) { blob = cb; }, renderTo: render };
  const closed = playMagnet('magnet', 'one', 'film.mp4', media, []); closed.destroy(); closed.destroy();
  ready!({ files: [file] }); expect(render).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledTimes(1);
  const pending = playMagnet('magnet', 'two', 'film.mp4', media, []);
  ready!({ files: [{ name: 'film.mp4', getBlobURL: file.getBlobURL }] }); pending.destroy(); blob!(null, 'blob:late');
  expect(media.src).toBe(''); expect(revoke).toHaveBeenCalledWith('blob:late');
  const active = playMagnet('magnet', 'three', 'film.mp4', media, []);
  ready!({ files: [{ name: 'film.mp4', getBlobURL: file.getBlobURL }] }); blob!(null, 'blob:active'); active.destroy();
  expect(media.src).toBe('blob:active'); expect(revoke).toHaveBeenCalledWith('blob:active');
});
