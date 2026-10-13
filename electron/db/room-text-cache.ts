/** Bounded LRU for repeatedly displayed protected text; no unbounded plaintext archive. */
export class RoomTextCache {
  private entries = new Map<string, { text: string; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxBytes = 1024 * 1024) {}

  get(encoded: string, decode: (value: string) => string): string {
    const cached = this.entries.get(encoded);
    if (cached) {
      this.entries.delete(encoded); this.entries.set(encoded, cached);
      return cached.text;
    }
    const text = decode(encoded);
    // Empty may mean an unavailable keychain or corrupt ciphertext: always retry it.
    const bytes = 2 * (encoded.length + text.length);
    if (!text || bytes > this.maxBytes) return text;
    while ((this.bytes + bytes > this.maxBytes || this.entries.size >= 4096) && this.entries.size) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
    }
    this.entries.set(encoded, { text, bytes }); this.bytes += bytes;
    return text;
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
}
