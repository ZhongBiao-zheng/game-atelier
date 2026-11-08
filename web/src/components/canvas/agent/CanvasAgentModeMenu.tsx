import { AiIcon, CheckIcon, ChevronDownIcon, ImageIcon, VideoIcon } from '@/components/ui/icons';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CanvasAgentCreationMode } from '@/schema/canvas';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export const CREATION_MODES: { value: CanvasAgentCreationMode; label: string; short: string; description: string; Icon: typeof AiIcon }[] = [
  { value: 'all', label: '全能创作', short: '全能', description: '按需求出图或出视频', Icon: AiIcon },
  { value: 'image', label: '图像创作', short: '图像', description: '只用图像模型', Icon: ImageIcon },
  { value: 'video', label: '视频创作', short: '视频', description: '只用视频模型', Icon: VideoIcon },
];

export function CanvasAgentModeMenu({ mode, disabled, onSelect }: {
  mode: CanvasAgentCreationMode;
  disabled?: boolean;
  onSelect: (mode: CanvasAgentCreationMode) => void;
}) {
  const current = CREATION_MODES.find(item => item.value === mode) ?? CREATION_MODES[0];
  return (
    <DropdownMenu>
      <Hint label={current.label}><DropdownMenuTrigger asChild>
        <Button variant="bare"
          type="button"
          disabled={disabled}
          aria-label="创作模式"
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <current.Icon size="sm" />
          {current.short}
          <ChevronDownIcon size="sm" />
        </Button>
      </DropdownMenuTrigger></Hint>
      {/* 面板是 z-40：菜单默认 z-20 会被压在面板下面，而 Radix 已锁住页面指针 → 整页像卡死。 */}
      <DropdownMenuContent side="top" align="start" className="z-50 w-52">
        {CREATION_MODES.map(item => (
          <DropdownMenuItem key={item.value} onSelect={() => onSelect(item.value)} className="items-start gap-2">
            <item.Icon className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{item.label}</span>
              <span className="block text-xs text-muted-foreground">{item.description}</span>
            </span>
            {item.value === mode && <CheckIcon size="sm" className="mt-0.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
