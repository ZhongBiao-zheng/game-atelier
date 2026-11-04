import type { GatewayPublishTarget } from '@/schema/gatewayShares';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { HelpCircle } from 'lucide-react';
export function GatewayPublishStatus({ targets }: { targets?: Record<string, GatewayPublishTarget> }) {
  if (!targets) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    {Object.entries(targets).map(([alias, target]) => {
      const minutes = target.synced_at ? Math.max(0, Math.floor((Date.now() - Date.parse(target.synced_at)) / 60000)) : 0;
      const text = target.error === '已被网关主机停止' ? target.error : target.delete_pending ? '停止共享待同步'
        : target.status === 'syncing' ? `同步中 ${target.uploaded}/${target.total}`
        : target.status === 'synced' ? `已同步 · ${minutes < 1 ? '刚刚' : `${minutes} 分钟前`}`
        : target.status === 'failed' ? '同步失败' : target.status === 'stopped' ? '已停止共享' : '等待同步';
      return <span key={alias} className="flex items-center gap-1">{Object.keys(targets).length > 1 && `${alias} · `}{text}
        {target.error && <Hint label={target.error}><Button variant="ghost" size="icon" className="size-6" aria-label={`${alias} 同步详情`}><HelpCircle className="size-3" /></Button></Hint>}
      </span>;
    })}
  </div>;
}
