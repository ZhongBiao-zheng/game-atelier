import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { AgentIcon, CheckIcon } from '@/components/ui/icons';
import { useCopyFeedback } from '@/lib/useCopyFeedback';

/** 外部 Agent（Claude Code、Codex 等）接着做这个画布用的一句话：带画布名与 project_id。 */
export function canvasAgentPrompt(name: string, projectId: string): string {
  return `在 Cobrush 画布「${name}」（project_id: ${projectId}）上继续：先用 canvas_get_document 读取画布，再按我接下来的要求操作。`;
}

/** 画布菜单里的「复制给外部 Agent」：复制后菜单不关，这一项显示「已复制」。 */
export function CanvasCopyForAgentItem({ name, projectId }: { name: string; projectId: string }) {
  const [copyState, copy] = useCopyFeedback();
  return (
    <DropdownMenuItem
      className="gap-2"
      onSelect={event => {
        event.preventDefault();
        copy(canvasAgentPrompt(name, projectId));
      }}
    >
      {copyState === 'copied' ? <CheckIcon aria-hidden="true" /> : <AgentIcon aria-hidden="true" />}
      {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制给外部 Agent'}
    </DropdownMenuItem>
  );
}
