import http from "node:http";
import type { Readable } from "node:stream";

interface StreamTorrent {
  files: Array<{
    length: number;
    type?: string;
    createReadStream(opts?: { start: number; end: number }): Readable;
  }>;
}

/** Per-torrent indexed URLs retained across WebTorrent versions. Loopback only. */
export function createTorrentStreamServer(
  torrent: StreamTorrent,
): http.Server {
  return http.createServer((req, res) => {
    const port = res.socket?.localPort ?? 0;
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== "null")
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const match = /^\/(\d+)(?:\?.*)?$/.exec(req.url || "");
    const file = match ? torrent.files[Number(match[1])] : undefined;
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string | number> = {
      "Content-Type": file.type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    };
    let start = 0,
      end = file.length - 1,
      status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) {
        res.writeHead(416, { "Content-Range": `bytes */${file.length}` }).end();
        return;
      }
      start = range[1]
        ? Number(range[1])
        : Math.max(0, file.length - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= file.length
      ) {
        res.writeHead(416, { "Content-Range": `bytes */${file.length}` }).end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${file.length}`;
    }
    headers["Content-Length"] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (req.method === "HEAD" || file.length === 0) {
      res.end();
      return;
    }
    try {
      const stream = file.createReadStream({ start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.destroy();
    }
  });
}
