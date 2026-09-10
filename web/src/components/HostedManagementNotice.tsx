import { localConnection, useConnectionState } from '@/api/connection';
import { Button } from '@/components/ui/button';

/** 托管网站上的管理页替身：密钥、数据目录与授权只在本机页面操作，这里只能看目标与断开。 */
export function HostedManagementNotice({ title }: { title: string }) {
  const connection = useConnectionState();
  const target = connection.target;
  return <div data-connection-controls className="mx-auto max-w-4xl space-y-6 px-6 py-8">
    <h1 className="font-display text-display">{title}</h1>
    <section className="space-y-3 rounded-lg border border-border bg-card p-5 text-sm">
      <p>已连接本机 <span className="font-mono">{target?.replace(/^https?:\/\//, '') ?? '—'}</span></p>
      <p className="text-muted-foreground">密钥、数据目录与 Agent 授权请在{target
        ? <a href={`${target}/settings`} target="_blank" rel="noreferrer" className="underline underline-offset-4">本机页面</a>
        : '本机页面'}管理；网站不接收原始密钥。</p>
      <Button variant="outline" size="sm" onClick={() => void localConnection.disconnect()}>断开本机连接</Button>
    </section>
  </div>;
}
