/** Same-renderer child windows register explicitly; no global Electron shortcut. */
const hosts = new Set<Window>();
const listeners = new Set<() => void>();
export const getCommandWindows = (): readonly Window[] => [...hosts];
export function registerCommandWindow(host: Window): () => void {
  hosts.add(host);
  listeners.forEach((listener) => listener());
  return () => {
    hosts.delete(host);
    listeners.forEach((listener) => listener());
  };
}
export function subscribeCommandWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
