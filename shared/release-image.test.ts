import { expect, it } from 'vitest';
import { releaseImageFormat } from './release-image';
import { releaseImageUrl } from './search-release-details';

const png = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXkAAAAASUVORK5CYII=', 'base64'));
it('accepts a bounded bitmap and rejects HTML and SVG regardless of extension', () => {
  expect(releaseImageFormat(png())).toBe('png');
  for (const bytes of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<html>Sign in</html>', 'not an image']) expect(() => releaseImageFormat(Buffer.from(bytes))).toThrow();
});
it('rejects excessive dimensions before decoding', () => {
  const bytes = png(), view = new DataView(bytes.buffer); view.setUint32(16, 100000);
  expect(() => releaseImageFormat(bytes)).toThrow();
  view.setUint32(16, 5000); view.setUint32(20, 5000); expect(() => releaseImageFormat(bytes)).toThrow();
});
it('reads JPEG SOF and both bounded WebP headers', () => {
  const jpeg = Uint8Array.from([255,216,255,192,0,7,8,0,90,0,160,255,217]);
  expect(releaseImageFormat(jpeg)).toBe('jpeg');
  const bytes = Buffer.alloc(30); bytes.write('RIFF',0); bytes.write('WEBPVP8X',8); bytes[24]=159; bytes[27]=89;
  expect(releaseImageFormat(bytes)).toBe('webp'); bytes[20]=2; expect(() => releaseImageFormat(bytes)).toThrow('Animated');
  bytes.fill(0,12); bytes.write('VP8L',12); bytes[20]=47; bytes.writeUInt32LE(159 | 89 << 14,21);
  expect(releaseImageFormat(bytes)).toBe('webp');
});
it('canonicalizes public image hosts and refuses local addresses or executable schemes', () => {
  expect(releaseImageUrl('http://images.example.org/a.jpg#preview')).toBe('https://images.example.org/a.jpg');
  for (const url of ['file:///private/image.png','data:image/png;base64,AA','javascript:alert(1)', 'https://user:pass@images.example.org/a.png',
    'https://localhost/a.png','https://localhost./a.png','https://a.local/a.png','https://127.0.0.1/a.png','http://2130706433/a.png',
    'https://[::1]/a.png','https://intranet/a.png','https://images.example.org:8443/a.png']) expect(releaseImageUrl(url)).toBeNull();
});
