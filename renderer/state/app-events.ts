import { useEffect, useState } from "react";
import type { AppEventSummary } from "../../shared/app-events";

export function useAppEventSummary(): AppEventSummary {
  const [summary, setSummary] = useState<AppEventSummary>({
    active: 0,
    unread: 0,
    total: 0,
    storage: "ready",
  });
  useEffect(() => {
    let alive = true,
      request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const sequence = ++request;
      void window.api.events
        ?.summary?.()
        .then((value) => {
          if (alive && sequence === request) setSummary(value);
        })
        .catch(() => {});
    };
    refresh();
    const off = window.api.events?.onChanged?.(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off?.();
    };
  }, []);
  return summary;
}
