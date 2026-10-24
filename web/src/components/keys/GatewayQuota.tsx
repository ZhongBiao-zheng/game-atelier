import { useEffect, useState } from 'react';
import { fetchGatewayProviderMe, type GatewayMe } from '@/api/gateway';
import { formatGenerationCost } from '@/lib/generationCost';
const PERIODS = { day: '今日', week: '本周', month: '本月' };
export function GatewayQuota({ alias }: { alias: string }) {
  const [me, setMe] = useState<GatewayMe | null>(null);
  useEffect(() => {
    let active = true; setMe(null);
    const refresh = () => { void fetchGatewayProviderMe(alias).then(data => { if (active) setMe(data); }).catch(() => { if (active) setMe(null); }); };
    refresh(); const timer = setInterval(refresh, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [alias]);
  if (!me) return null;
  return <div className="space-y-1 text-xs text-muted-foreground" aria-label="中转额度">{me.limits.map(limit => <p key={limit.period}>
    {PERIODS[limit.period]} {formatGenerationCost(limit.used_cny + limit.reserved_cny)} / {formatGenerationCost(limit.cap_cny)} · {new Date(limit.resets_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} 重置
  </p>)}</div>;
}
