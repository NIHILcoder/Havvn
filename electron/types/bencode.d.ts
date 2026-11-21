declare module 'bencode' {
  const codec: {
    decode(data: Uint8Array): unknown;
    encode(value: unknown): Uint8Array;
  };
  export default codec;
}
