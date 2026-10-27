import { useEffect, useState } from 'react';
import { readEngineCapabilities, type EngineCapabilities } from '../../shared/engine-capabilities';

export function useEngineCapabilities() {
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const reply = readEngineCapabilities(await window.api.getEngineCapabilities());
        if (!reply) throw Error('Unknown engine capabilities');
        if (alive) { setCapabilities(reply); setFailed(false); }
      } catch { if (alive) { setCapabilities(null); setFailed(true); } }
    })();
    return () => { alive = false; };
  }, []);
  return { capabilities, failed };
}
