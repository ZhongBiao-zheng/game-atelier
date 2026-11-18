import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AccentColors } from '@/lib/accentPresets';
import type { AccentDoc } from '@/lib/accentTheme';
import { ACCENT_THEME_NAME_MAX } from '@/schema/accentThemes';
import { ColorFields, themeNameError } from './ThemeEditor';

/** 新增主题 / 另存为：起名 + 四个颜色。 */
export function ThemeDialog({ doc, initial, busy, error, onCreate, onClose }: {
  doc: AccentDoc; initial: { name: string; colors: AccentColors }; busy: boolean; error: string | null;
  onCreate: (name: string, colors: AccentColors) => void; onClose: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(initial.name);
  const [colors, setColors] = useState(initial.colors);
  const nameError = themeNameError(doc, name);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-xl">
      <DialogTitle>新主题</DialogTitle>
      <form autoComplete="off" className="space-y-4" onSubmit={event => {
        event.preventDefault();
        if (!nameError && !busy) onCreate(name.trim(), colors);
      }}>
        <div className="space-y-1.5">
          <Label htmlFor={nameId} className="text-sm">名称</Label>
          <Input id={nameId} value={name} autoFocus maxLength={ACCENT_THEME_NAME_MAX} aria-invalid={!!nameError}
            onChange={event => setName(event.target.value)} />
          {nameError && name.trim() && <p role="alert" className="text-xs text-destructive">{nameError}</p>}
        </div>
        <ColorFields colors={colors} onChange={setColors} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={!!nameError || busy}>创建</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
