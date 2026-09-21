import WebTorrent from "webtorrent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(path.join(process.cwd(), "package.json"));
const { createTorrentStreamServer } = req(
  "./dist/electron/electron/torrent/stream-server.js",
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-wt3-"));
const data = Buffer.alloc(256 * 1024, 37);
const file = path.join(root, "fixture.bin");
fs.writeFileSync(file, data);
const options = {
  tracker: false,
  dht: false,
  lsd: false,
  utp: false,
  natUpnp: false,
  natPmp: false,
};
const seedClient = new WebTorrent(options),
  downloadClient = new WebTorrent(options);
const timer = setTimeout(() => {
  console.error("Transfer timeout");
  process.exit(2);
}, 30000);
let server;
try {
  const seed = await new Promise((resolve, reject) => {
    seedClient.on("error", reject);
    seedClient.seed(file, { announce: [] }, resolve);
  });
  const target = downloadClient.add(seed.torrentFile, {
    path: path.join(root, "download"),
    announce: [],
  });
  await new Promise((resolve, reject) => {
    target.on("error", reject);
    target.on("ready", resolve);
  });
  assert.equal(await downloadClient.get(seed.infoHash), target);
  target.pause();
  assert.equal(target.paused, true);
  target.resume();
  assert.equal(target.paused, false);
  const done = new Promise((resolve, reject) => {
    target.on("done", resolve);
    target.on("error", reject);
  });
  target.addPeer("127.0.0.1:" + seedClient.torrentPort);
  await done;
  assert.deepEqual(
    fs.readFileSync(path.join(root, "download", "fixture.bin")),
    data,
  );
  server = createTorrentStreamServer(target);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/0";
  const response = await fetch(url, { headers: { Range: "bytes=10-29" } });
  assert.equal(response.status, 206);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    data.subarray(10, 30),
  );
  assert.equal(
    (await fetch(url, { headers: { Origin: "https://evil.example" } })).status,
    403,
  );
  assert.equal(
    (await fetch(url, { headers: { Range: "bytes=999999-" } })).status,
    416,
  );
  console.log(
    "PASS: ESM, local seed/download, get, pause/resume, byte integrity, HTTP Range, origin rejection",
  );
} finally {
  server?.closeAllConnections();
  server?.close();
  await Promise.all(
    [seedClient, downloadClient].map((c) => new Promise((r) => c.destroy(r))),
  );
  clearTimeout(timer);
}
