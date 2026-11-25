import { useEffect, useState } from 'react';
import { listKeys } from '@/api/keys';
import { GatewayQuota } from './GatewayQuota';
import { Collapse } from '@/components/ui/collapse';
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
  // 有网关连接才出现：展开长出来，不把下面的图表一下顶开。
  return (
    <Collapse open={aliases.length > 0} appear>
    <div className="space-y-3 rounded-xl border border-border bg-card p-5" aria-label="团队网关额度">
      <h2 className="text-xs text-muted-foreground">团队网关额度</h2>
      {aliases.map((alias) => (
        <div key={alias} className="space-y-2 text-xs">
          <p>{alias}</p>
          <GatewayQuota alias={alias} />
        </div>
      ))}
    </div>
    </Collapse>
  );
}
