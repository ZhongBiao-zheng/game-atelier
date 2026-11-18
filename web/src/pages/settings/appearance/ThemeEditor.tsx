import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AccentColors } from '@/lib/accentPresets';
import {
  accentCardContrast, previewAccent, sameColors, themeNameTaken,
  type AccentDoc, type AccentThemeView,
} from '@/lib/accentTheme';
import { ACCENT_THEME_NAME_MAX } from '@/schema/accentThemes';
import { useTheme } from '@/lib/theme';
import { ColorField } from './ColorField';

export const COLOR_FIELDS: { key: keyof AccentColors; label: string; usage: string }[] = [
  { key: 'primary', label: '主色', usage: '当前选中、主操作' },
  { key: 'brand2', label: '副色 1', usage: '图片标签' },
  { key: 'brand3', label: '副色 2', usage: '视频标签' },
  { key: 'brand4', label: '副色 3', usage: '文本标签' },
];

/** 名称校验：去首尾空白后非空、不超长、不与任何主题（含内置）重名。返回错误文案或 null。 */
export function themeNameError(doc: AccentDoc, name: string, exceptId?: string) {
  const trimmed = name.trim();
  if (!trimmed) return '请输入名称';
  if (trimmed.length > ACCENT_THEME_NAME_MAX) return `最多 ${ACCENT_THEME_NAME_MAX} 个字`;
  if (themeNameTaken(doc, trimmed, exceptId)) return '名称已存在';
  return null;
}

export function ColorFields({ colors, onChange }: { colors: AccentColors; onChange: (colors: AccentColors) => void }) {
  return <div className="grid min-w-0 gap-3 sm:grid-cols-2">
    {COLOR_FIELDS.map(field => <ColorField key={field.key} label={field.label} usage={field.usage} value={colors[field.key]}
      onChange={value => onChange({ ...colors, [field.key]: value })} />)}
  </div>;
}

/** 当前主题的编辑区：草稿实时预览，保存才落盘；切走或卸载时撤掉预览。 */
export function ThemeEditor({ doc, theme, defaults, busy, onSave, onSaveAs, onReset, onDelete }: {
  doc: AccentDoc; theme: AccentThemeView; defaults: AccentColors | null; busy: boolean;
  onSave: (name: string, colors: AccentColors) => void;
  onSaveAs: (colors: AccentColors) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const nameId = useId();
  const mode = useTheme();
  const [colors, setColors] = useState(theme.colors);
  const [name, setName] = useState(theme.name);
  const colorsDirty = !sameColors(colors, theme.colors);
  const nameError = theme.builtin ? null : themeNameError(doc, name, theme.id);
  const dirty = colorsDirty || (!theme.builtin && name.trim() !== theme.name);
  const previewColors = useMemo(() => colorsDirty ? colors : null, [colorsDirty, colors]);
  useEffect(() => { previewAccent(previewColors); }, [previewColors]);
  useEffect(() => () => previewAccent(null), []);

  return <div className="space-y-3 px-4.5 pb-4">
    {!theme.builtin && <div className="flex items-center justify-between gap-3">
      <Label htmlFor={nameId} className="text-sm">名称</Label>
      <div className="flex min-w-0 flex-col items-end gap-1">
        <Input id={nameId} value={name} maxLength={ACCENT_THEME_NAME_MAX} aria-invalid={!!nameError}
          onChange={event => setName(event.target.value)} className="w-40" />
        {nameError && <p role="alert" className="text-xs text-destructive">{nameError}</p>}
      </div>
    </div>}
    <ColorFields colors={colors} onChange={setColors} />
    {accentCardContrast(colors.primary, mode) < 3 && <p role="status" className="text-xs text-status-running">主色与卡片对比度较低，建议调亮主色。</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={!dirty || !!nameError || busy} onClick={() => onSave(name.trim(), colors)}>保存</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSaveAs(colors)}>另存为新主题</Button>
      <div className="ml-auto flex items-center gap-2">
        {theme.builtin && defaults && (theme.edited || colorsDirty) && <Button type="button" size="sm" variant="ghost" disabled={busy}
          onClick={() => { setColors(defaults); if (theme.edited) onReset(); }}>恢复默认</Button>}
        {!theme.builtin && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDelete}
          className="text-destructive hover:text-destructive">删除</Button>}
      </div>
    </div>
  </div>;
}
