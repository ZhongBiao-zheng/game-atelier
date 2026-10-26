import { useEffect, useState } from 'react';
import { listKeys } from '@/api/keys';
import { GatewayQuota } from './GatewayQuota';
export function QuotaCard() {
  const [aliases, setAliases] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    listKeys()
      .then(({ keys }) => {
        if (active) setAliases(keys.filter((key) => key.provider === 'atelier').map((key) => key.alias));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!aliases.length) return null;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-5" aria-label="局域网额度">
      <h2 className="text-xs text-muted-foreground">局域网额度</h2>
      {aliases.map((alias) => (
        <div key={alias} className="space-y-2 text-xs">
          <p>{alias}</p>
          <GatewayQuota alias={alias} />
        </div>
      ))}
    </div>
  );
}
