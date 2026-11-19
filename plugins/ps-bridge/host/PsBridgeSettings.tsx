import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';

import { fetchPsStatus, type PsBridgeStatus } from './api';

function statusText(status: PsBridgeStatus): string {
  if (!status.supported) return '当前系统暂不支持';
  if (status.version) return `Photoshop ${status.version}${status.active_document ? ` · ${status.active_document}` : ''}`;
  if (status.running) return 'Photoshop 已启动';
  return status.installed ? 'Photoshop 未启动' : '未检测到 Photoshop';
}

/** 设置 → 插件里 PS 联动的状态区。打开时不和 Photoshop 说话；点「检测」才读版本（第一次会弹系统授权框）。 */
export function PsBridgeSettings() {
  const [status, setStatus] = useState<PsBridgeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchPsStatus(false)
      .then(next => { if (active) setStatus(next); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setStatus(await fetchPsStatus(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  const app = status?.responsible_app;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
    <p role="status" className="text-xs text-muted-foreground">{status ? statusText(status) : '读取中…'}</p>
    {app && status?.supported && <Hint label={`第一次检测时，macOS 会请你允许 ${app} 控制 Photoshop；弹窗可能在其他窗口后面`}>
      <p className="w-fit text-xs text-muted-foreground">授权应用 {app}</p>
    </Hint>}
    <Button variant="ghost" size="sm" disabled={checking || !status?.supported} onClick={() => void check()}>
      {checking ? '检测中…' : '检测'}
    </Button>
    {error && <p role="alert" className="basis-full text-xs text-destructive">{error}</p>}
  </div>;
}
