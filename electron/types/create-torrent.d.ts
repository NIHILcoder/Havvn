declare module 'create-torrent' {
  export default function createTorrent(input: string | Uint8Array | Array<string | import('node:stream').Readable>,
    options: { name?: string; announce?: string[]; announceList?: string[][]; pieceLength?: number; private?: boolean;
      comment?: string; createdBy?: string; urlList?: string[]; info?: Record<string, unknown>;
      filterJunkFiles?: boolean; onProgress?: (hashedBytes: number, totalBytes: number) => void },
    callback: (error: Error | null, result?: Uint8Array) => void): void;
}

declare module 'fs-chunk-store' {
  const Store: any;
  export default Store;
}
