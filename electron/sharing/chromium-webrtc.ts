import { registerHooks } from "node:module";

let installed = false;
/** WebTorrent 3's peer library imports webrtc-polyfill instead of accepting wrtc.
 * Route just that module to its own browser entry inside Electron preloads.
 * Utility processes keep the normal Node implementation.
 */
export function useChromiumWebRTC(): void {
  if (installed || process.type !== "renderer") return;
  if (typeof window.RTCPeerConnection !== "function")
    throw new Error("Chromium WebRTC is unavailable");
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      return specifier === "webrtc-polyfill"
        ? { ...resolved, url: new URL("./browser.js", resolved.url).href }
        : resolved;
    },
  });
  installed = true;
}
