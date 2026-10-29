import { useCallback, useEffect, useRef, useState } from 'react';
import { writeClipboardText } from './clipboard';

/** A copied indicator is an acknowledgement of a completed clipboard write. */
export function useClipboardCopy(value: string, callbacks: { onSuccess?: () => void; onError?: () => void; writeText?: (text: string) => Promise<void> } = {}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const current = useRef({ value, callbacks });
  current.current = { value, callbacks };
  const active = useRef<object>();
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    active.current = undefined; clearTimeout(timer.current);
    setCopied(false); setCopying(false);
  }, [value]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current = undefined; clearTimeout(timer.current); };
  }, []);
  const copy = useCallback(async () => {
    if (!value || active.current) return false;
    const task = {}; active.current = task;
    clearTimeout(timer.current); setCopied(false); setCopying(true);
    const stillCurrent = () => mounted.current && active.current === task && current.current.value === value;
    try {
      await (current.current.callbacks.writeText ?? writeClipboardText)(value);
      if (stillCurrent()) {
        setCopied(true);
        timer.current = setTimeout(() => { if (mounted.current && current.current.value === value) setCopied(false); }, 2000);
        current.current.callbacks.onSuccess?.();
      }
      return true;
    } catch {
      if (stillCurrent()) current.current.callbacks.onError?.();
      return false;
    } finally {
      if (stillCurrent()) { active.current = undefined; setCopying(false); }
    }
  }, [value]);
  return { copied, copying, copy };
}
