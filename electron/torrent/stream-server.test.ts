import { afterEach, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import http from "node:http";
import { createTorrentStreamServer } from "./stream-server";
let server: Server;
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function start() {
  const data = Buffer.from("0123456789");
  server = createTorrentStreamServer({
    files: [
      {
        length: data.length,
        type: "video/mp4",
        createReadStream: (range) =>
          Readable.from(
            data.subarray(range?.start ?? 0, range ? range.end + 1 : undefined),
          ),
      },
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("missing port");
  return `http://127.0.0.1:${a.port}/0`;
}
it("serves complete, partial and HEAD responses with content type", async () => {
  const url = await start();
  const res = await fetch(url);
  expect(res.headers.get("content-type")).toBe("video/mp4");
  expect(await res.text()).toBe("0123456789");
  const partial = await fetch(url, { headers: { Range: "bytes=2-4" } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(await partial.text()).toBe("234");
  const suffix = await fetch(url, { headers: { Range: "bytes=-2" } });
  expect(await suffix.text()).toBe("89");
  const head = await fetch(url, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
});
it("rejects foreign Origin, forged Host, bad ranges and unknown paths", async () => {
  const url = await start();
  expect(
    (await fetch(url, { headers: { Origin: "https://evil.example" } })).status,
  ).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(url, { headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
  expect(status).toBe(403);
  expect((await fetch(url, { headers: { Range: "bytes=20-" } })).status).toBe(
    416,
  );
  expect((await fetch(url.replace("/0", "/1"))).status).toBe(404);
  expect((await fetch(url, { method: "POST" })).status).toBe(405);
});
