import { useEffect, useId, useState } from 'react';
import { isHexColor } from '@/lib/accentTheme';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ColorField({ label, usage, value, onChange }: {
  label: string; usage: string; value: string; onChange: (value: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <div className="flex items-center justify-between gap-3">
    <div className="min-w-0"><Label htmlFor={id} className="text-sm">{label}</Label>
      <p className="text-xs text-muted-foreground">{usage}</p></div>
    <div className="flex shrink-0 items-center gap-2">
      <Input variant="bare" type="color" value={value} aria-label={`${label}取色器`}
        onChange={event => onChange(event.target.value)}
        className="size-8 cursor-pointer rounded-sm border border-input bg-transparent p-0.5" />
      <Input id={id} value={draft} spellCheck={false} maxLength={7} aria-invalid={!isHexColor(draft)}
        onChange={event => { setDraft(event.target.value); if (isHexColor(event.target.value)) onChange(event.target.value); }}
        className="w-24 font-mono" />
    </div>
  </div>;
}
