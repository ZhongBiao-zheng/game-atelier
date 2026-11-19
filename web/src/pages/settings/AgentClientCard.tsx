import type { AgentClient, AgentClientRow } from '@/api/agentConnection';
import { Button } from '@/components/ui/button';
import { CheckIcon } from '@/components/ui/icons';
import { Hint } from '@/components/ui/tooltip';
import { useCopyFeedback } from '@/lib/useCopyFeedback';

export const CLIENT_LABEL: Record<AgentClient, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'claude-desktop': 'Claude Desktop',
  trae: 'TRAE', workbuddy: 'WorkBuddy',
};
/** 只能复制的客户端：粘到哪里。 */
const PASTE_HINT: Partial<Record<AgentClient, string>> = {
  'claude-code': '在终端运行',
  trae: '粘贴到 设置 › MCP › 手动添加',
  workbuddy: '粘贴到 连接器 › 自定义连接器',
};

/** 配置路径的显示：用户目录缩成 ~，拆成目录与文件名（目录过长时省略，文件名始终完整，悬停看全）。 */
export function shortPath(path: string): { dir: string; name: string } {
  const home = path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\])/, '~');
  const cut = Math.max(home.lastIndexOf('/'), home.lastIndexOf('\\')) + 1;
  return { dir: home.slice(0, cut), name: home.slice(cut) };
}

/** 一个客户端：连接状态 + 一键写入（能写的）+ 复制配置。凭据不在配置里，适配器自己读。 */
export function AgentClientCard({ row, connectedAt, busy, onWrite }: {
  row: AgentClientRow;
  connectedAt?: string;
  busy: boolean;
  onWrite: (client: AgentClient) => void;
}) {
  const [copyState, copy] = useCopyFeedback();
  const label = CLIENT_LABEL[row.id];
  return <section aria-label={label} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4.5">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="flex-1 text-sm font-medium">{label}</h3>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${connectedAt ? 'bg-status-done' : 'bg-subtle-foreground'}`} />
        {connectedAt ? `已连接 · ${new Date(connectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '等待连接'}
      </span>
    </div>
    {row.mode === 'plugin' ? (
      <p className="text-xs text-muted-foreground">已通过插件接入</p>
    ) : <>
      {row.warning
        ? <p role="note" className="text-xs text-destructive">{row.warning}</p>
        : row.path
          ? <div className="flex min-w-0 items-center gap-2 text-xs">
            <Hint label={row.path}><span className="flex min-w-0 flex-1 font-mono">
              <span className="min-w-0 truncate">{shortPath(row.path).dir}</span>
              <span className="shrink-0">{shortPath(row.path).name}</span>
            </span></Hint>
            {row.written && <span className="flex shrink-0 items-center gap-1 text-muted-foreground"><CheckIcon size="sm" aria-hidden />已写入</span>}
          </div>
          : <p className="text-xs text-muted-foreground">{PASTE_HINT[row.id]}</p>}
      <div className="mt-auto flex flex-wrap gap-2">
        {row.mode === 'write' && !row.written && (
          <Button size="sm" disabled={busy} onClick={() => onWrite(row.id)}>写入配置</Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => copy(row.snippet)}>
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败'
            : row.id === 'claude-code' ? '复制命令' : '复制配置'}
        </Button>
      </div>
    </>}
  </section>;
}
