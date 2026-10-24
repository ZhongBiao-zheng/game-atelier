import { accentCardContrast, accentColors, setAccent, useAccent } from '@/lib/accentTheme';
import { setTheme, useTheme, useThemePreference, type ThemePreference } from '@/lib/theme';
import type { AccentColors } from '@/lib/accentPresets';
import { PresetGrid } from './PresetGrid';
import { ColorField } from './ColorField';
import { ThemePreview } from './ThemePreview';

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
  return <section className="mb-10 space-y-5 border-b border-border pb-10" aria-labelledby="appearance-title">
    <h2 id="appearance-title" className="text-base font-medium">外观</h2>
    <div className="flex flex-wrap items-center gap-4">
      <span className="text-sm text-muted-foreground">模式</span>
      <div className="flex rounded-md bg-background p-1" aria-label="外观模式">
        {MODES.map(item => <button type="button" key={item.value} aria-pressed={preference === item.value}
          onClick={() => setTheme(item.value)}
          className={`rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${preference === item.value ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
      </div>
    </div>
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0 space-y-5">
        <div className="space-y-2"><p className="text-sm text-muted-foreground">主题色</p><PresetGrid state={state} /></div>
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-medium">自定义{'custom' in state && <span className="ml-2 text-xs text-muted-foreground">已启用</span>}</h3>
            <button type="button" onClick={() => setAccent({ preset: 'lime' })} className="text-xs text-muted-foreground hover:text-foreground">恢复默认</button></div>
          {FIELDS.map(field => <ColorField key={field.key} label={field.label} usage={field.usage} value={colors[field.key]}
            onChange={value => setAccent({ custom: { primary: colors.primary, brand2: colors.brand2, brand3: colors.brand3, brand4: colors.brand4, [field.key]: value } })} />)}
          {accentCardContrast(colors.primary, mode) < 3 && <p role="status" className="text-xs text-status-running">主色与卡片对比度较低，建议调亮主色。</p>}
        </div>
      </div>
      <ThemePreview />
    </div>
  </section>;
}
