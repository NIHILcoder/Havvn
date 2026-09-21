const { ipcRenderer } = require("electron");
require(
  process.cwd() + "/dist/electron/electron/sharing/chromium-webrtc.js",
).useChromiumWebRTC();
(async () => {
  const rtc = await import("webrtc-polyfill");
  if (rtc.RTCPeerConnection !== window.RTCPeerConnection)
    throw Error("Not using Chromium WebRTC");
  const { default: Peer } = await import("@thaunknown/simple-peer/lite.js");
  const a = new Peer({
      initiator: true,
      trickle: false,
      config: { iceServers: [] },
    }),
    b = new Peer({ trickle: false, config: { iceServers: [] } });
  a.on("signal", (s) => b.signal(s));
  b.on("signal", (s) => a.signal(s));
  await new Promise((resolve, reject) => {
    a.on("error", reject);
    b.on("error", reject);
    a.on("connect", () => a.send("havvn-rtc-smoke"));
    b.on("data", (data) => {
      if (Buffer.from(data).toString() === "havvn-rtc-smoke") resolve();
      else reject(Error("data mismatch"));
    });
  });
  a.destroy();
  b.destroy();
  ipcRenderer.send("wt3-rtc", { ok: true });
})().catch((e) => ipcRenderer.send("wt3-rtc", { ok: false, error: e.stack }));
