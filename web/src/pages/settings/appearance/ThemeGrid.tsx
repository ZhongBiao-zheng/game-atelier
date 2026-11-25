import type { CSSProperties } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { AddIcon } from '@/components/ui/icons';
import type { AccentThemeView } from '@/lib/accentTheme';

const TILE = 'accent-preset h-auto min-w-0 flex-col rounded-xl p-1.5 pb-2.5 text-xs font-normal';

export function ThemeGrid({ themes, active, canAdd, onSelect, onAdd }: {
  themes: AccentThemeView[]; active: string; canAdd: boolean;
  onSelect: (id: string) => void; onAdd: () => void;
}) {
  return <ToggleGroup type="single" aria-label="主题色" className="grid w-full grid-cols-4 gap-2 sm:grid-cols-7"
    value={active} onValueChange={value => { if (value) onSelect(value); }}>
    {themes.map(theme => <ToggleGroupItem key={theme.id} value={theme.id} aria-label={theme.name}
      style={{ '--preset-primary': theme.colors.primary, '--preset-2': theme.colors.brand2,
        '--preset-3': theme.colors.brand3, '--preset-4': theme.colors.brand4 } as CSSProperties}
      className={`${TILE} data-[state=on]:bg-transparent`}>
      <span className="accent-swatch aspect-square w-full rounded-lg" aria-hidden />
      <span className="w-full truncate">{theme.name}</span>
    </ToggleGroupItem>)}
    {canAdd && <Button type="button" variant="ghost" aria-label="新增主题" onClick={onAdd}
      className={`${TILE} border border-transparent text-muted-foreground hover:text-foreground`}>
      <span className="grid aspect-square w-full place-items-center rounded-lg border border-dashed border-border" aria-hidden>
        <AddIcon size="lg" />
      </span>
      <span>新增</span>
    </Button>}
  </ToggleGroup>;
}
