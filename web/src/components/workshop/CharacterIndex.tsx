import { connectionFetch } from '@/api/connection';
import { useEffect, useMemo, useState } from 'react';
import { Layers2, MoreHorizontal, Pencil, Plus, Search, Trash2, UserRound } from 'lucide-react';

import { apiError } from '@/api/http';
import { fetchCharacterIndex, type CharacterIndexItem } from '@/api/characters';
import type { CharacterEntry } from '@/schema/jobs';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateDerivativeDialog } from './CreateDerivativeDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function CharacterIndex({
  projectId,
  onOpenCharacter,
}: {
  projectId: string;
  onOpenCharacter: (id: string, name: string) => void;
}) {
  const [items, setItems] = useState<CharacterIndexItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<CharacterEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [derivativeSource, setDerivativeSource] = useState<CharacterEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CharacterEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCharacterIndex(projectId)
      .then(value => { if (!cancelled) setItems(value); })
      .catch(reason => { if (!cancelled) setError((reason as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter(item => item.character.name.toLocaleLowerCase().includes(needle));
  }, [items, query]);

  async function createCharacter() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const response = await connectionFetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, project_id: projectId }),
      });
      if (!response.ok) throw await apiError(response, `新建角色「${name}」`);
      const character = await response.json() as CharacterEntry;
      setCreating(false);
      setNewName('');
      onOpenCharacter(character.id, character.name);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function renameCharacter() {
    if (!renaming) return;
    const name = renameDraft.trim();
    if (!name || name === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      const response = await connectionFetch(`/api/characters/${encodeURIComponent(renaming.id)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw await apiError(response, `重命名角色「${renaming.name}」`);
      setItems(current => current.map(item => item.character.id === renaming.id
        ? { ...item, character: { ...item.character, name } }
        : item));
      setRenaming(null);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function deleteCharacter() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const response = await connectionFetch(`/api/characters/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (!response.ok) throw await apiError(response, `删除角色「${target.name}」`);
      setItems(current => current.filter(item => item.character.id !== target.id));
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <section className="space-y-5" aria-label="角色索引">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-label text-muted-foreground/70">Character Index</p>
          <h1 className="mt-2 font-display text-display italic text-foreground">全部角色</h1>
        </div>
        <label className="relative block w-full max-w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label="搜索角色"
            placeholder="搜索角色"
            className="pl-9"
          />
        </label>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">正在读取角色…</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          <div className="min-h-64 rounded-lg border border-dashed border-border bg-card/20 p-4">
            {creating ? (
              <div className="flex h-full flex-col justify-center gap-3">
                <Input
                  autoFocus
                  value={newName}
                  onChange={event => setNewName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void createCharacter();
                    if (event.key === 'Escape') setCreating(false);
                  }}
                  aria-label="新角色名称"
                  placeholder="角色名称"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void createCharacter()} className="min-h-10 flex-1 rounded-md bg-primary px-3 text-sm text-primary-foreground">创建</button>
                  <button type="button" onClick={() => setCreating(false)} className="min-h-10 rounded-md border border-border px-3 text-sm text-muted-foreground">取消</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                aria-label="新建角色"
                className="grid h-full min-h-56 w-full place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span className="space-y-2 text-center">
                  <Plus className="mx-auto size-6" aria-hidden />
                  <span className="block text-sm font-medium">新建角色</span>
                </span>
              </button>
            )}
          </div>
          {visible.map(item => (
            <CharacterCard
              key={item.character.id}
              item={item}
              onOpen={onOpenCharacter}
              renaming={renaming?.id === item.character.id}
              renameDraft={renameDraft}
              onRenameDraft={setRenameDraft}
              onStartRename={() => {
                setRenaming(item.character);
                setRenameDraft(item.character.name);
              }}
              onCommitRename={() => void renameCharacter()}
              onCancelRename={() => setRenaming(null)}
              onCreateDerivative={() => setDerivativeSource(item.character)}
              onDelete={() => setDeleteTarget(item.character)}
            />
          ))}
        </div>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `删除角色「${deleteTarget.name}」？` : '删除角色？'}
        message="角色目录和其中图片会从磁盘删除，不可恢复。"
        variant="destructive"
        onConfirm={() => void deleteCharacter()}
        onCancel={() => setDeleteTarget(null)}
      />
      <CreateDerivativeDialog
        source={derivativeSource}
        projectId={projectId}
        open={derivativeSource !== null}
        onOpenChange={open => { if (!open) setDerivativeSource(null); }}
        onCreated={character => {
          setDerivativeSource(null);
          onOpenCharacter(character.id, character.name);
        }}
      />
    </section>
  );
}

function CharacterCard({
  item,
  onOpen,
  renaming,
  renameDraft,
  onRenameDraft,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCreateDerivative,
  onDelete,
}: {
  item: CharacterIndexItem;
  onOpen: (id: string, name: string) => void;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (value: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onCreateDerivative: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="relative overflow-hidden rounded-lg border border-border bg-card/30 transition-colors hover:bg-secondary/40">
      <button
        type="button"
        onClick={() => onOpen(item.character.id, item.character.name)}
        aria-label={`打开角色 ${item.character.name}`}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="block h-48 bg-border">
        {item.cover_path ? (
          <img
            src={`/api/gallery/image?path=${encodeURIComponent(item.cover_path)}`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="grid h-full place-items-center bg-card text-muted-foreground">
            <UserRound className="size-7" aria-hidden />
          </span>
        )}
        </span>
      </button>
      <div className="min-h-20 p-4 pr-12">
        {renaming ? (
          <form
            aria-label={`重命名角色 ${item.character.name}`}
            className="space-y-2"
            onSubmit={event => { event.preventDefault(); onCommitRename(); }}
          >
            <Input
              autoFocus
              value={renameDraft}
              onChange={event => onRenameDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') onCancelRename(); }}
              aria-label="角色新名称"
              className="h-8 text-xs"
            />
            <button type="submit" className="text-xs text-primary">保存名称</button>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onOpen(item.character.id, item.character.name)}
              className="block text-base font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {item.character.name}
            </button>
            <span className="mt-1 block text-xs text-muted-foreground">最近活动 {formatActivity(item.activity_at)}</span>
          </>
        )}
      </div>
      {!renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`管理角色 ${item.character.name}`} className="absolute bottom-3 right-3 grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onStartRename}><Pencil className="size-4" aria-hidden />重命名</DropdownMenuItem>
            <DropdownMenuItem onSelect={onCreateDerivative}><Layers2 className="size-4" aria-hidden />创建衍生</DropdownMenuItem>
            <DropdownMenuItem onSelect={onDelete} className="text-destructive"><Trash2 className="size-4" aria-hidden />删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </article>
  );
}

function formatActivity(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleDateString('zh-CN');
}
