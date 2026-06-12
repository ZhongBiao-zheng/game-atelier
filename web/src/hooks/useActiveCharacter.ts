import { useEffect, useState } from 'react';
import type { ActiveCharacterFile } from '../schema/jobs';

/** undefined = 首次请求未返回；null = 已确认没有活跃角色。 */
export function useActiveCharacter(refreshSignal: number): string | null | undefined {
  const [activeId, setActiveId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/active-character')
      .then(r => r.json() as Promise<ActiveCharacterFile>)
      .then(d => { if (!cancelled) setActiveId(d.active_id); });
    return () => { cancelled = true; };
  }, [refreshSignal]);

  return activeId;
}
