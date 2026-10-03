declare module 'create-torrent' {
  export default function createTorrent(input: string | Uint8Array,
    options: { name?: string; announce?: string[]; pieceLength?: number },
    callback: (error: Error | null, result?: Uint8Array) => void): void;
}

declare module 'fs-chunk-store' {
  const Store: any;
  export default Store;
}
