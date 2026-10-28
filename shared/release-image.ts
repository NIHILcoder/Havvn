/** Inspect dimensions before Chromium decodes a remote bitmap. No SVG/HTML. */
export function releaseImageFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, text: string) => at + text.length <= bytes.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  let width = 0, height = 0, format: 'png' | 'jpeg' | 'webp' | undefined;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 'PNG\r\n\x1a\n') && ascii(12, 'IHDR')) {
    format = 'png'; width = view.getUint32(16); height = view.getUint32(20);
    // Animated images are not needed for release previews.
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      if (ascii(offset + 4, 'acTL')) throw new Error('Animated image');
      const size = view.getUint32(offset); if (size > bytes.length - offset - 12) break;
      offset += size + 12;
    }
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker >= 208 && marker <= 215 || marker === 1) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || size > bytes.length - offset) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7) {
        format = 'jpeg'; height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  } else if (bytes.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    format = 'webp';
    const u24 = (at: number) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
    if (ascii(12, 'VP8X')) {
      if (bytes[20] & 2) throw new Error('Animated image');
      width = u24(24) + 1; height = u24(27) + 1;
    } else if (ascii(12, 'VP8 ') && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
    } else if (ascii(12, 'VP8L') && bytes[20] === 47) {
      const bits = view.getUint32(21, true); width = (bits & 16383) + 1; height = (bits >>> 14 & 16383) + 1;
    }
  }
  if (!format || !width || !height || width > 8192 || height > 8192 || width * height > 16000000) throw new Error('Unsupported preview image');
  return format;
}
