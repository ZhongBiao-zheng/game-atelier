import { useEffect, useState } from 'react';
import { Check, UsersRound } from 'lucide-react';

import {
  fetchManualCharacterAssociations,
  fetchCharacterIndex,
  setCharacterAssociation,
  type CharacterAssociationItem,
  type CharacterAssociationTarget,
} from '@/api/characters';
import type { CharacterEntry } from '@/schema/jobs';
import { cn } from '@/lib/utils';

export function CharacterAssociationPicker({
  projectId,
  target,
}: {
  projectId: string;
  target: CharacterAssociationTarget;
}) {
  const [open, setOpen] = useState(false);
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [associations, setAssociations] = useState<CharacterAssociationItem[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchCharacterIndex(projectId),
      fetchManualCharacterAssociations(projectId),
    ]).then(([characterIndex, items]) => {
      if (cancelled) return;
      setCharacters(characterIndex.map(item => item.character));
      setAssociations(items);
    }).catch(reason => { if (!cancelled) setError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function toggle(characterId: string) {
    const selected = associations.some(item => (
      item.character_id === characterId && sameTarget(item.target, target)
    ));
    setSavingId(characterId);
    setError(null);
    try {
      setAssociations(await setCharacterAssociation(projectId, characterId, target, !selected));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <UsersRound className="size-4" aria-hidden />
        关联角色
      </button>
      {open && (
        <section aria-label="手动关联角色" className="space-y-2 rounded-lg border border-border bg-card/30 p-3">
          <p className="text-xs text-muted-foreground">补充关联只影响角色工作台，不改变作品归属。</p>
          {characters.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {characters.map(character => {
                const selected = associations.some(item => (
                  item.character_id === character.id && sameTarget(item.target, target)
                ));
                return (
                  <button
                    key={character.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={savingId !== null}
                    onClick={() => void toggle(character.id)}
                    className={cn(
                      'inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      selected ? 'border-primary/60 text-primary' : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    {selected && <Check className="size-3.5" aria-hidden />}
                    {character.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">当前项目还没有角色。</p>
          )}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </section>
      )}
    </div>
  );
}

function sameTarget(left: CharacterAssociationTarget, right: CharacterAssociationTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'ui' && right.kind === 'ui') {
    return left.scheme_id === right.scheme_id && left.screen_id === right.screen_id;
  }
  return left.kind === 'video' && right.kind === 'video'
    && left.production_id === right.production_id;
}
