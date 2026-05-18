import { useEffect, useState } from 'react';
import type { ActiveCharacterFile } from '../schema/jobs';

export function useActiveCharacter(refreshSignal: number): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/active-character')
      .then(r => r.json() as Promise<ActiveCharacterFile>)
      .then(d => { if (!cancelled) setActiveId(d.active_id); });
    return () => { cancelled = true; };
  }, [refreshSignal]);

  return activeId;
}
