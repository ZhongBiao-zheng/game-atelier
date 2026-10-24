import type { CSSProperties } from 'react';
import { ACCENT_PRESETS } from '@/lib/accentPresets';
import { setAccent, type AccentState } from '@/lib/accentTheme';

export function PresetGrid({ state }: { state: AccentState }) {
  return <div className="grid grid-cols-4 gap-2 sm:grid-cols-7" aria-label="主题色预设">
    {ACCENT_PRESETS.map((preset, index) => <button key={preset.id} type="button"
      aria-pressed={'preset' in state && state.preset === preset.id}
      onClick={() => setAccent({ preset: preset.id })}
      style={{ '--preset-primary': preset.primary, '--preset-2': preset.brand2,
        '--preset-3': preset.brand3, '--preset-4': preset.brand4, '--i': index } as CSSProperties}
      className="accent-preset flex flex-col items-center gap-2 rounded-xl border border-transparent p-1.5 pb-2.5 text-xs text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="accent-swatch aspect-square w-full rounded-lg" aria-hidden />
      {preset.name}
    </button>)}
  </div>;
}
