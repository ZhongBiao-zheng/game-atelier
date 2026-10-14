import { useEffect, useState } from 'react';

import { disableAgent, enableAgent, fetchAgentStatus, type AgentClient, type AgentStatus } from '@/api/agentConnection';
import { Switch } from '@/components/ui/switch';

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

  return (
    <>
      <h2 className="text-base font-medium text-foreground">Agent 连接</h2>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-foreground">允许 Claude Code 与 Codex 操作本机</p>
            {status?.enabled && (
              <p role="status" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span aria-hidden className={`size-1.5 rounded-full ${connected.length ? 'bg-[color:var(--status-done)]' : 'bg-muted-foreground/40'}`} />
                {connected.length
                  ? `已连接 · ${connected.map(client => `${CLIENT_LABEL[client]} ${new Date(status.connections[client]!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`).join(' · ')}`
                  : '等待 Agent 连接'}
              </p>
            )}
          </div>
          <Switch checked={Boolean(status?.enabled)} label="允许 Agent 操作本机" disabled={!status || busy} onChange={next => void toggle(next)} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </>
  );
}
