import { Moon, Sun } from 'lucide-react';

import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { setTheme, useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
];

export function CanvasThemeSelector() {
  const theme = useTheme();

  return (
    <DropdownMenuRadioGroup
      value={theme}
      aria-label="画布主题"
      className="grid grid-cols-2 gap-y-1 rounded-lg bg-popover p-1"
      onValueChange={value => {
        if (value === 'light' || value === 'dark') setTheme(value);
      }}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = theme === value;
        return (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            aria-label={`${label}主题`}
            className={cn(
              'h-8 justify-center gap-1.5 px-2 py-0 font-medium focus:bg-secondary focus-visible:ring-2 focus-visible:ring-primary [&>span:first-child]:hidden',
              selected
                ? 'bg-secondary text-foreground ring-1 ring-primary/60'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}
