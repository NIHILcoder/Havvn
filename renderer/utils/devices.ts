import { useEffect, useState } from "react";
import type { DeviceUiState } from "../../shared/device-ui";
export function useDevices() {
  const [state, setState] = useState<DeviceUiState | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.api.devices
        ?.state()
        .then((s) => {
          if (alive) {
            setState(s);
            setError(false);
          }
        })
        .catch(() => {
          if (alive) setError(true);
        });
    };
    const off = window.api.devices?.changed(refresh);
    refresh();
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return { state, setState, error };
}
export const notifyDeviceChange = () =>
  window.dispatchEvent(new Event("havvn:device-local"));
const active = new Map<object, { identity: string; path: string }>();
export function retainDevicePlayer(identity: string, path: string) {
  const token = {};
  active.set(token, { identity, path });
  const send = () => window.api.devices?.activeMedia([...active.values()]);
  send();
  return () => {
    active.delete(token);
    send();
  };
}
export function listenDeviceChanges() {
  const apply = () => {
    const scale = Number(localStorage.getItem("uiScale") ?? "100");
    window.api.setZoomFactor?.(
      [90, 100, 110, 125].includes(scale) ? scale / 100 : 1,
    );
    if (localStorage.getItem("reduceMotion") === "1")
      document.documentElement.dataset.reduceMotion = "true";
    else delete document.documentElement.dataset.reduceMotion;
    if (localStorage.getItem("density") === "compact")
      document.documentElement.dataset.density = "compact";
    else delete document.documentElement.dataset.density;
  };
  window.addEventListener("storage", apply);
  const dirty = () => window.api.devices?.localChanged();
  for (const event of [
    "storage",
    "havvn:device-local",
    "havvn:watchHistory",
    "havvn:settings-transfer",
    "havvn:working-profile",
  ])
    window.addEventListener(event, dirty);
}
