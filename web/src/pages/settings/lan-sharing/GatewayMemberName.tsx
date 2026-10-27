import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

export function GatewayMemberName({ name, disabled, onSave }: {
  name: string;
  disabled: boolean;
  onSave: (name: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const active = useRef(false);
  const saving = useRef(false);
  const composing = useRef(false);
  function cancel() {
    active.current = false;
    setEditing(false);
    setDraft(name);
  }
  async function save(input = draft) {
    if (!active.current || saving.current || composing.current) return;
    const value = input.trim();
    if (!value || value === name) { cancel(); return; }
    if (value.length > 40) return;
    saving.current = true;
    try {
      if (await onSave(value)) { active.current = false; setEditing(false); }
    } finally { saving.current = false; }
  }
  return editing ? <Input aria-label={`修改 ${name} 的名称`} autoFocus maxLength={40}
    disabled={disabled} value={draft} className="h-8 min-w-24 text-xs"
    onChange={event => setDraft(event.target.value)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => {
      composing.current = false;
      if (document.hasFocus() && document.activeElement !== event.currentTarget) void save(event.currentTarget.value);
    }}
    onBlur={() => { if (document.hasFocus()) void save(); }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      if (event.key === 'Enter') { event.preventDefault(); void save(); }
    }} /> : <button type="button" title={name} aria-label={`重命名 ${name}`} disabled={disabled}
      className="min-w-0 truncate rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-default disabled:hover:text-inherit"
      onClick={() => { setDraft(name); active.current = true; setEditing(true); }}>{name}</button>;
}
