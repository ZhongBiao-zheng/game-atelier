import { useEffect, useState } from 'react';
import {
  accentThemes, activeTheme, builtinColors, newThemeId, syncAccentThemes, uniqueThemeName, updateAccentThemes,
  useAccent, withBuiltinOverride, type AccentDoc,
} from '@/lib/accentTheme';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setTheme, useThemePreference, type ThemePreference } from '@/lib/theme';
import { ACCENT_PRESETS, type AccentColors, type AccentPreset } from '@/lib/accentPresets';
import { ACCENT_USER_THEME_MAX, type AccentThemesBody } from '@/schema/accentThemes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { ChevronDownIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { ThemeGrid } from './ThemeGrid';
import { ThemeEditor } from './ThemeEditor';
import { ThemeDialog } from './ThemeDialog';

const MODES: { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'system', label: '跟随系统' },
];
const body = (doc: AccentDoc): AccentThemesBody => ({ active: doc.active, overrides: doc.overrides, custom: doc.custom });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AppearanceSection() {
  const doc = useAccent();
  const preference = useThemePreference();
  const themes = accentThemes(doc);
  const theme = activeTheme(doc);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; colors: AccentColors } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => { syncAccentThemes().catch(cause => setError(message(cause))); }, []);

  const save = async (change: (current: AccentDoc) => AccentThemesBody) => {
    setBusy(true);
    try {
      await updateAccentThemes(change);
      setError(null);
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const create = (name: string, colors: AccentColors) => {
    const id = newThemeId();
    void save(current => ({ ...body(current), active: id, custom: [...current.custom, { id, name, ...colors }] }))
      .then(ok => { if (ok) setCreating(null); });
  };
  const saveActive = (name: string, colors: AccentColors) => void save(current => theme.builtin
    ? { ...body(current), overrides: withBuiltinOverride(current.overrides, theme.id as AccentPreset, { name, colors }) }
    : { ...body(current), custom: current.custom.map(item => item.id === theme.id ? { id: item.id, name, ...colors } : item) });

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
        <p className="text-sm">主题色</p>
        <ThemeGrid themes={themes} active={doc.active} canAdd={doc.custom.length < ACCENT_USER_THEME_MAX}
          onSelect={id => void save(current => ({ ...body(current), active: id }))}
          onAdd={() => setCreating({ name: uniqueThemeName(doc, '新主题'), colors: theme.colors })} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
      <div>
        <Button type="button" variant="ghost" aria-expanded={editing} onClick={() => setEditing(open => !open)}
          className="h-auto w-full justify-between rounded-none px-4.5 py-3.5 text-sm font-normal hover:bg-transparent">
          编辑主题
          <ChevronDownIcon size="sm" className={cn('text-muted-foreground transition-transform', editing && 'rotate-180')} aria-hidden />
        </Button>
        <Collapse open={editing}>
          <ThemeEditor key={`${theme.id}:${theme.name}:${Object.values(theme.colors).join()}`}
            doc={doc} theme={theme} busy={busy}
            defaults={theme.builtin ? { name: ACCENT_PRESETS.find(preset => preset.id === theme.id)!.name, colors: builtinColors(theme.id as AccentPreset) } : null}
            onSave={saveActive}
            onSaveAs={colors => setCreating({ name: uniqueThemeName(doc, theme.name), colors })}
            onReset={() => setResetting(true)}
            onDelete={() => setDeleting(true)} />
        </Collapse>
      </div>
    </div>
    {creating && <ThemeDialog doc={doc} initial={creating} busy={busy} error={error}
      onCreate={create} onClose={() => { setCreating(null); setError(null); }} />}
    <ConfirmDialog open={deleting} variant="destructive" title={`删除「${theme.name}」？`} message="删除后无法恢复。" confirmText="删除"
      onCancel={() => setDeleting(false)}
      onConfirm={() => {
        setDeleting(false);
        void save(current => ({ ...body(current), active: 'lime', custom: current.custom.filter(item => item.id !== theme.id) }));
      }} />
    <ConfirmDialog open={resetting} title={`恢复「${theme.name}」的默认设置？`} message="名称和颜色回到内置值。" confirmText="恢复"
      onCancel={() => setResetting(false)}
      onConfirm={() => {
        setResetting(false);
        void save(current => ({ ...body(current), overrides: withBuiltinOverride(current.overrides, theme.id as AccentPreset, null) }));
      }} />
  </section>;
}

