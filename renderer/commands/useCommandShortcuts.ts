import { useEffect, useRef } from "react";
import { isModalOpen } from "../components/Modal";
import { loadHotkeys, subscribeHotkeys, matchHotkey } from "../utils/hotkeys";
import { getCommandWindows, subscribeCommandWindows } from "./windows";

export function useCommandShortcuts(
  open: (host: Window) => void,
  execute: (id: string) => void,
): void {
  const current = useRef({ open, execute });
  current.current = { open, execute };
  useEffect(() => {
    let hotkeys = loadHotkeys();
    const offKeys = subscribeHotkeys(() => {
      hotkeys = loadHotkeys();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || isModalOpen())
        return;
      const hotkey = matchHotkey(hotkeys, e);
      if (!hotkey) return;
      const target = e.target as HTMLElement | null;
      if (
        hotkey.id !== "open-command-palette" &&
        target?.closest?.(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      e.preventDefault();
      if (hotkey.id === "open-command-palette")
        current.current.open(e.currentTarget as Window);
      else current.current.execute(hotkey.id);
    };
    let attached: readonly Window[] = [];
    const update = () => {
      attached.forEach((w) => w.removeEventListener("keydown", onKey));
      attached = [window, ...getCommandWindows()].filter((w) => !w.closed);
      attached.forEach((w) => w.addEventListener("keydown", onKey));
    };
    update();
    const offWindows = subscribeCommandWindows(update);
    return () => {
      offKeys();
      offWindows();
      attached.forEach((w) => w.removeEventListener("keydown", onKey));
    };
  }, []);
}
