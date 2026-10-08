import { Check, ChevronDown, Clapperboard, Image as ImageIcon, Sparkles } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CanvasAgentCreationMode } from '@/schema/canvas';

export const CREATION_MODES: { value: CanvasAgentCreationMode; label: string; description: string; Icon: typeof Sparkles }[] = [
  { value: 'all', label: '全能创作', description: '按需求出图或出视频', Icon: Sparkles },
  { value: 'image', label: '图像创作', description: '只用图像模型', Icon: ImageIcon },
  { value: 'video', label: '视频创作', description: '只用视频模型', Icon: Clapperboard },
];

export function CanvasAgentModeMenu({ mode, disabled, onSelect }: {
  mode: CanvasAgentCreationMode;
  disabled?: boolean;
  onSelect: (mode: CanvasAgentCreationMode) => void;
}) {
  const current = CREATION_MODES.find(item => item.value === mode) ?? CREATION_MODES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="创作模式"
          className="flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <current.Icon className="size-3.5" />
          {current.label}
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-52">
        {CREATION_MODES.map(item => (
          <DropdownMenuItem key={item.value} onSelect={() => onSelect(item.value)} className="items-start gap-2">
            <item.Icon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{item.label}</span>
              <span className="block text-xs text-muted-foreground">{item.description}</span>
            </span>
            {item.value === mode && <Check className="mt-0.5 size-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
