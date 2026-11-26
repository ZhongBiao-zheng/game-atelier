import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { AiIcon, ArrowToolIcon } from '@/components/ui/icons';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, useAnimateOnChange } from '@/lib/motion';

const SUGGESTION_LINE = /^(?:[-*•]\s*|\d+[.)、]\s*)?(?:→|->|⇒)\s*(.+)$/;
const MAX_SUGGESTIONS = 3;

/** 回复末尾连续的 `→ ` 行是推荐追问（约定见 agent_instructions.CORE「汇报」），从正文里剥离；正文中间的箭头行不算。 */
export function parseAgentReply(raw: string): { body: string; suggestions: string[] } {
  const lines = raw.trimEnd().split('\n');
  const suggestions: string[] = [];
  let end = lines.length;
  while (end > 0) {
    const trimmed = lines[end - 1].trim();
    const match = trimmed.match(SUGGESTION_LINE);
    if (match) suggestions.unshift(match[1].trim());
    else if (trimmed) break;
    end -= 1;
  }
  return { body: lines.slice(0, end).join('\n').trim(), suggestions: suggestions.slice(0, MAX_SUGGESTIONS) };
}

/** 画布面板与创作台时间线共用的「继续探索」。一轮结束、追问出现（或换了一组）时淡入并上移 4px，
 *  减弱动态效果时只淡入；打开时已有的不播。 */
export function AgentSuggestions({ suggestions, onPick }: { suggestions: string[]; onPick: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimateOnChange(suggestions.join('\n'), (value, _previous, reduced) => {
    const element = ref.current;
    if (!value || !element) return;
    const keyframes = reduced ? { opacity: [0, 1] } : { opacity: [0, 1], y: [4, 0] };
    clearOnFinish(animate(element, keyframes, { duration: MOTION_DURATION.base, ease: MOTION_EASE.out }), element);
  }, { keepWhenReduced: true });
  if (suggestions.length === 0) return null;
  return (
    <div ref={ref} aria-label="推荐追问" className="flex flex-col items-start gap-2 pt-2">
      <span className="flex items-center gap-1.5 text-xs text-subtle-foreground">
        <AiIcon size="sm" />继续探索
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {suggestions.map((text, idx) => (
          <Button
            key={idx}
            variant="outline"
            size="sm"
            type="button"
            onClick={() => onPick(text)}
            className="group h-auto rounded-full border-border bg-card/70 px-3.5 py-1.5 text-left text-xs font-normal text-muted-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 hover:text-foreground"
          >
            <span>{text}</span>
            <ArrowToolIcon size="sm" className="ml-1 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </Button>
        ))}
      </div>
    </div>
  );
}
