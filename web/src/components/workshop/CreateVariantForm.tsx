import { useId, useState } from 'react';
import { Check, X } from 'lucide-react';

import { createCharacterVariant } from '@/api/characters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CharacterEntry } from '@/schema/jobs';

export function CreateVariantForm({
  parent,
  folderId,
  onCancel,
  onCreated,
}: {
  parent: CharacterEntry;
  folderId?: string;
  onCancel: () => void;
  onCreated: (entry: CharacterEntry) => void;
}) {
  const nameId = useId();
  const differenceId = useId();
  const errorId = useId();
  const [name, setName] = useState('');
  const [difference, setDifference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !difference.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createCharacterVariant(
        parent.id,
        name.trim(),
        difference.trim(),
        folderId,
      ));
    } catch (errorValue) {
      setError((errorValue as Error).message);
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={`为 ${parent.name} 新建皮肤`}
      onSubmit={event => { void submit(event); }}
      className="space-y-3 rounded-lg border border-border bg-card p-3"
    >
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-xs font-medium text-foreground">
          皮肤名称（必填）
        </label>
        <Input
          id={nameId}
          autoFocus
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder={`例如：${parent.name}·夏日`}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={differenceId} className="text-xs font-medium text-foreground">
          相对母角色的差异（必填）
        </label>
        <Input
          id={differenceId}
          value={difference}
          onChange={event => setDifference(event.target.value)}
          placeholder="服装、配色、气质和保留项"
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          <X aria-hidden />
          取消
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || !difference.trim() || busy}>
          <Check aria-hidden />
          {busy ? '创建中…' : '创建皮肤'}
        </Button>
      </div>
    </form>
  );
}
