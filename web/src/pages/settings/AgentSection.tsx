import { useEffect, useState } from 'react';

import { disableAgent, enableAgent, fetchAgentStatus, type AgentClient, type AgentStatus } from '@/api/agentConnection';
import { Switch } from '@/components/ui/switch';
import { Hint } from '@/components/ui/tooltip';

const CLIENT_LABEL: Record<AgentClient, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
// Agent 一开会话就会连过来，开着设置页时轮询，状态自己亮。
const POLL_MS = 5000;

/** 一个开关：打开即允许本机的 Claude Code / Codex 操作全部项目与画布。 */
export function AgentSection() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => fetchAgentStatus().then(next => { if (active) setStatus(next); });
    load().catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    const timer = window.setInterval(() => { load().catch(() => {}); }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await (next ? enableAgent() : disableAgent()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 开关的服务端状态可能已经变了（例如凭据写好了、Codex 配置写失败），以服务端为准。
      fetchAgentStatus().then(setStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const connected = status
    ? (Object.keys(CLIENT_LABEL) as AgentClient[]).filter(client => status.connections[client])
    : [];

  return <div className="min-w-0 space-y-5">
    <section aria-label="Agent 状态" className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-sm font-semibold">允许本机 Agent 操作项目与画布</h2>
        <p role="status" className="text-xs text-muted-foreground">{!status ? '读取中…' : status.enabled ? `${connected.length} 个已连接` : '关闭后 Claude Code 与 Codex 无法读写画布'}</p>
      </div>
      <Switch checked={Boolean(status?.enabled)} aria-label="允许 Agent 操作本机" disabled={!status || busy} onCheckedChange={next => void toggle(next)} />
    </section>
    {status?.enabled && <>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {(Object.keys(CLIENT_LABEL) as AgentClient[]).map(client => <section key={client} aria-label={CLIENT_LABEL[client]} className="min-w-0 space-y-3.5 rounded-xl border border-border bg-card p-4.5">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs">{client === 'codex' ? 'CX' : 'CC'}</span>
            <h3 className="flex-1 text-sm font-medium">{CLIENT_LABEL[client]}</h3>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status.connections[client] ? 'bg-status-done' : 'bg-subtle-foreground'}`} />
              {status.connections[client] ? `已连接 · ${new Date(status.connections[client]!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '等待连接'}
            </span>
          </div>
          <div className="flex items-start gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">{client === 'claude-code' ? '凭据' : '配置'}</span>
            <span className="min-w-0 break-all font-mono">{status.config_paths[client] ?? '—'}</span>
          </div>
        </section>)}
      </div>
      <section aria-label="可用工具" className="space-y-2.5">
        <h2 className="text-sm font-semibold">可用工具 <span className="font-normal text-muted-foreground">{status.tools.length}</span></h2>
        <div className="flex flex-wrap gap-1.5">
          {status.tools.map(tool => <Hint key={tool.name} label={tool.billable ? '计费工具' : undefined}><span className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-mono text-xs">
            <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tool.billable ? 'bg-status-running' : 'bg-status-done'}`} /><span className="break-all">{tool.name}</span>
          </span></Hint>)}
        </div>
        {status.tools.some(tool => tool.billable) && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-running" />计费工具需先获得你的授权</p>}
      </section>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
