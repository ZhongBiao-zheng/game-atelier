import { accentCardContrast, accentColors, setAccent, useAccent } from '@/lib/accentTheme';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setTheme, useTheme, useThemePreference, type ThemePreference } from '@/lib/theme';
import type { AccentColors } from '@/lib/accentPresets';
import { PresetGrid } from './PresetGrid';
import { ColorField } from './ColorField';
import { Button } from '@/components/ui/button';

const MODES: { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'system', label: '跟随系统' },
];
const FIELDS: { key: keyof AccentColors; label: string; usage: string }[] = [
  { key: 'primary', label: '主色', usage: '当前选中、主操作' },
  { key: 'brand2', label: '副色 1', usage: '图片标签' },
  { key: 'brand3', label: '副色 2', usage: '视频标签' },
  { key: 'brand4', label: '副色 3', usage: '文本标签' },
];
export function AppearanceSection() {
  const state = useAccent();
  const colors = accentColors(state);
  const preference = useThemePreference();
  const mode = useTheme();
  return <section id="appearance" className="scroll-mt-6 space-y-2" aria-labelledby="appearance-title">
    <h2 id="appearance-title" className="px-1 text-xs font-normal text-muted-foreground">外观</h2>
    <div className="divide-y divide-border rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4.5 py-3.5">
        <span className="text-sm">模式</span>
        <ToggleGroup type="single" variant="outline" aria-label="外观模式" value={preference}
          onValueChange={value => { if (value) setTheme(value as typeof preference); }}>
          {MODES.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <div className="space-y-3 px-4.5 py-3.5">
        <p className="text-sm">主题色</p><PresetGrid state={state} />
      </div>
      <details>
        <summary className="cursor-pointer px-4.5 py-3.5 text-sm">自定义颜色{'custom' in state && <span className="ml-2 text-xs text-muted-foreground">已启用</span>}</summary>
        <div className="space-y-3 px-4.5 pb-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {FIELDS.map(field => <ColorField key={field.key} label={field.label} usage={field.usage} value={colors[field.key]}
              onChange={value => setAccent({ custom: { primary: colors.primary, brand2: colors.brand2, brand3: colors.brand3, brand4: colors.brand4, [field.key]: value } })} />)}
          </div>
          {accentCardContrast(colors.primary, mode) < 3 && <p role="status" className="text-xs text-status-running">主色与卡片对比度较低，建议调亮主色。</p>}
          <Button variant="bare" type="button" onClick={() => setAccent({ preset: 'lime' })} className="text-xs text-muted-foreground hover:text-foreground">恢复默认</Button>
        </div>
      </details>
    </div>
  </section>;
}
