/* eslint-disable @typescript-eslint/no-require-imports -- Native acceptance fixture only. */
const { ipcRenderer, contextBridge } = require("electron"),
  path = require("node:path");
const compiled = path.join(process.env.HAVVN_DP03_REPO, "dist/electron");
const { attachDeviceDataClient } = require(
  path.join(compiled, "electron/device-data-client.js"),
);
const { bindDeviceView } = require(
  path.join(compiled, "shared/device-data-target.js"),
);
let writes = 0,
  failAfter = Infinity;
const storage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => {
    if (writes >= failAfter) throw Error("injected storage failure");
    writes++;
    localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (writes >= failAfter) throw Error("injected storage failure");
    writes++;
    localStorage.removeItem(key);
  },
};
attachDeviceDataClient(ipcRenderer, storage);
contextBridge.exposeInMainWorld("dataTest", {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  writes: () => writes,
  failAfter: (remaining) => {
    failAfter = remaining === null ? Infinity : writes + remaining;
  },
  bind: (localId, syncId) => bindDeviceView(storage, localId, syncId, () => {}),
});
