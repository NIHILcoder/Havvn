/** Page changes wait for editors to preserve their buffers or ask the user. */
export function createPageLeave() {
  const guards = new Set<() => boolean | Promise<boolean>>();
  let pending: Promise<boolean> | null = null, latest: (() => void) | null = null;
  return {
    register(guard: () => boolean | Promise<boolean>) { guards.add(guard); return () => { guards.delete(guard); }; },
    run(action: () => void): Promise<boolean> {
      latest = action;
      if (pending) return pending;
      pending = Promise.resolve().then(async () => {
        try {
          for (const guard of [...guards].reverse()) if (guards.has(guard) && !await guard()) return false;
          const commit = latest; latest = null; commit?.(); return true;
        } catch { return false; }
        finally { latest = null; pending = null; }
      });
      return pending;
    },
  };
}
export const pageLeave = createPageLeave();
