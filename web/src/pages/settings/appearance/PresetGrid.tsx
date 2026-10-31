import type { CSSProperties } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ACCENT_PRESETS } from '@/lib/accentPresets';
import { setAccent, type AccentState } from '@/lib/accentTheme';

export function PresetGrid({ state }: { state: AccentState }) {
  return <ToggleGroup type="single" aria-label="主题色预设" className="grid w-full grid-cols-4 gap-2 sm:grid-cols-7"
    value={'preset' in state ? state.preset : ''}
    onValueChange={value => { const preset = ACCENT_PRESETS.find(item => item.id === value); if (preset) setAccent({ preset: preset.id }); }}>
    {ACCENT_PRESETS.map((preset, index) => <ToggleGroupItem key={preset.id} value={preset.id}
      style={{ '--preset-primary': preset.primary, '--preset-2': preset.brand2,
        '--preset-3': preset.brand3, '--preset-4': preset.brand4, '--i': index } as CSSProperties}
      className="accent-preset h-auto flex-col rounded-xl p-1.5 pb-2.5 text-xs font-normal data-[state=on]:bg-transparent">
      <span className="accent-swatch aspect-square w-full rounded-lg" aria-hidden />
      {preset.name}
    </ToggleGroupItem>)}
  </ToggleGroup>;
}
