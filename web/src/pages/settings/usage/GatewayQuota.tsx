import { useEffect, useState } from 'react';
import { fetchGatewayProviderMe, type GatewayMe } from '@/api/gateway';
import { formatGenerationCost } from '@/lib/generationCost';
const PERIODS = { day: '今日', week: '本周', month: '本月', none: '累计' };
export function GatewayQuota({ alias }: { alias: string }) {
  const [me, setMe] = useState<GatewayMe | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    setMe(null);
    setLoaded(false);
    const refresh = () => {
      void fetchGatewayProviderMe(alias)
        .then((data) => {
          if (active) setMe(data);
        })
        .catch(() => {
          if (active) setMe(null);
        })
        .finally(() => {
          if (active) setLoaded(true);
        });
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [alias]);
  // 第一次读取前占一行骨架，额度到了原位换上，不顶开下方内容；读不到就不显示。
  if (!loaded) return <div data-skeleton aria-hidden className="h-4 w-32 rounded bg-secondary/60" />;
  if (!me) return null;
  // 新主机回 quota（一条，可能不重置）；旧主机只回 limits（可能多条）。
  const rows = me.quota !== undefined ? (me.quota ? [me.quota] : []) : me.limits;
  return (
    <div className="space-y-1 text-xs tabular-nums text-muted-foreground" aria-label="团队网关额度">
      {rows.map((limit) => (
        <p
          key={limit.period}
          className={
            (limit.used_cny + limit.reserved_cny) / limit.cap_cny > 0.9
              ? 'text-[color:var(--status-running)]'
              : ''
          }
        >
          {PERIODS[limit.period]} {formatGenerationCost(limit.used_cny + limit.reserved_cny)} /{' '}
          {formatGenerationCost(limit.cap_cny)}
          {limit.resets_at
            ? <> · {new Date(limit.resets_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} 重置</>
            : ' · 不重置'}
        </p>
      ))}
    </div>
  );
}
