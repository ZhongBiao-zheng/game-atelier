import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Layers2, LibraryBig, Trash2, UserPlus } from 'lucide-react';
import { Link } from 'wouter';

import { apiError, clip } from '@/api/http';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateDerivativeDialog } from '@/components/workshop/CreateDerivativeDialog';
import { ProjectNavigation } from '@/components/workshop/ProjectNavigation';
import type { WorkshopWorkspace } from '@/components/workshop/workspaces';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { CharacterEntry, ProjectsFile } from '@/schema/jobs';

interface Props {
  sseSignal: number;
  selectedId?: string | null;
  onSelect: (id: string, name: string, projectId?: string) => void;
  onDelete?: (id: string) => void;
  activeProjectId?: string | null;
  workspace?: WorkshopWorkspace;
  onNavigate?: () => void;
}

export function LeftSidebar({
  sseSignal,
  selectedId,
  onSelect,
  onDelete,
  activeProjectId = null,
  workspace = 'overview',
  onNavigate,
}: Props) {
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [projects, setProjects] = useState<ProjectsFile>({ projects: [], assignments: {} });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [creatingCharacter, setCreatingCharacter] = useState(false);
  const [newCharacterName, setNewCharacterName] = useState('');
  const [derivativeSource, setDerivativeSource] = useState<CharacterEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CharacterEntry | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const newCharacterInputRef = useRef<HTMLInputElement | null>(null);
  const derivativeTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    fetch('/api/characters').then(response => response.json()).then(setCharacters);
    fetch('/api/projects').then(response => response.json()).then(setProjects);
  }, [sseSignal]);

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  useEffect(() => {
    if (creatingCharacter) newCharacterInputRef.current?.focus();
  }, [creatingCharacter]);

  const activeProject = activeProjectId
    ? projects.projects.find(project => project.id === activeProjectId) ?? null
    : null;
  const projectCharacters = activeProject
    ? characters.filter(character => projects.assignments[character.id] === activeProject.id)
    : [];

  function startCharacterEdit(character: CharacterEntry, event: React.MouseEvent) {
    event.stopPropagation();
    setEditingId(character.id);
    setDraftName(character.name);
    setError(null);
  }

  function cancelCharacterEdit() {
    setEditingId(null);
    setDraftName('');
  }

  async function commitCharacterEdit() {
    if (!editingId) return;
    const name = draftName.trim();
    const original = characters.find(character => character.id === editingId);
    if (!name || original?.name === name) {
      cancelCharacterEdit();
      return;
    }
    try {
      const response = await fetch(`/api/characters/${editingId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw await apiError(response, `把角色改名为「${clip(name)}」`);
      setCharacters(current => current.map(character => (
        character.id === editingId ? { ...character, name } : character
      )));
      cancelCharacterEdit();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  function startNewCharacter() {
    setCreatingCharacter(true);
    setNewCharacterName('');
    setError(null);
  }

  function cancelNewCharacter() {
    setCreatingCharacter(false);
    setNewCharacterName('');
  }

  async function commitNewCharacter() {
    const name = newCharacterName.trim();
    if (!name || !activeProject) {
      cancelNewCharacter();
      return;
    }
    try {
      const createdResponse = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, project_id: activeProject.id }),
      });
      if (!createdResponse.ok) throw await apiError(createdResponse, `新建角色「${clip(name)}」`);
      const entry = await createdResponse.json() as CharacterEntry;
      setProjects(current => ({
        ...current,
        assignments: { ...current.assignments, [entry.id]: activeProject.id },
      }));
      setCharacters(current => [...current, entry]);
      cancelNewCharacter();
      onSelect(entry.id, entry.name, activeProject.id);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const response = await fetch(`/api/characters/${target.id}`, { method: 'DELETE' });
      if (!response.ok) throw await apiError(response, `删除角色「${target.name}」`);
      setCharacters(current => current.filter(character => character.id !== target.id));
      setProjects(current => ({
        ...current,
        assignments: Object.fromEntries(
          Object.entries(current.assignments).filter(([characterId]) => characterId !== target.id),
        ),
      }));
      onDelete?.(target.id);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  if (!activeProject) {
    return (
      <aside className="flex h-full flex-col border-r border-border p-3">
        <Link
          href="/workshop"
          onClick={onNavigate}
          className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <LibraryBig className="size-4" aria-hidden />
          全部项目
        </Link>
      </aside>
    );
  }

  return (
    <>
      <aside className="flex h-full flex-col border-r border-border">
        <div className="stable-scroll flex-1 overflow-y-auto px-2 py-3">
          {creatingCharacter && (
            <div className="mb-3 flex items-center gap-2 px-2">
              <UserPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Input
                ref={newCharacterInputRef}
                value={newCharacterName}
                onChange={event => setNewCharacterName(event.target.value)}
                onBlur={() => void commitNewCharacter()}
                onKeyDown={event => {
                  if (event.key === 'Enter') void commitNewCharacter();
                  if (event.key === 'Escape') cancelNewCharacter();
                }}
                aria-label="新角色名称"
                placeholder="角色名"
                className="h-8 text-xs"
              />
            </div>
          )}

          <ProjectNavigation
            project={activeProject}
            projects={projects.projects}
            workspace={workspace}
            characters={projectCharacters}
            selectedCharacterId={selectedId}
            onNavigate={onNavigate}
            onNewCharacter={startNewCharacter}
            renderCharacter={renderCharacter}
          />
        </div>

        {error && (
          <div role="alert" className="mx-2 mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}
      </aside>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `删除角色「${deleteTarget.name}」？` : '删除角色？'}
        message="角色目录和其中图片会从磁盘删除，不可恢复。"
        variant="destructive"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
      <CreateDerivativeDialog
        source={derivativeSource}
        projectId={activeProject.id}
        open={derivativeSource !== null}
        onOpenChange={open => {
          if (open) return;
          setDerivativeSource(null);
          window.requestAnimationFrame(() => derivativeTriggerRef.current?.focus());
        }}
        onCreated={entry => {
          setCharacters(current => [...current, entry]);
          setProjects(current => ({
            ...current,
            assignments: { ...current.assignments, [entry.id]: activeProject.id },
          }));
          setDerivativeSource(null);
          onSelect(entry.id, entry.name, activeProject.id);
        }}
      />
    </>
  );

  function renderCharacter(character: CharacterEntry) {
    const isActive = character.id === selectedId;
    const isEditing = character.id === editingId;
    const projectId = projects.assignments[character.id];
    return (
        <li
          key={character.id}
          onClick={() => !isEditing && onSelect(character.id, character.name, projectId)}
          onDoubleClick={event => startCharacterEdit(character, event)}
          onKeyDown={event => {
            if (isEditing) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(character.id, character.name, projectId);
            }
          }}
          role={isEditing ? undefined : 'button'}
          tabIndex={isEditing ? undefined : 0}
          aria-label={isEditing ? undefined : character.name}
          aria-pressed={isEditing ? undefined : isActive}
          title="双击重命名"
          className={cn(
            'group/character relative flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isEditing ? 'cursor-text' : 'cursor-pointer',
            isActive ? 'bg-secondary text-foreground' : 'text-foreground/85 hover:bg-accent/50',
          )}
        >
          {isActive && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />}
          <CharacterAvatar name={character.name} thumbnail={character.thumbnail} active={isActive} />
          {isEditing ? (
            <Input
              ref={editInputRef}
              value={draftName}
              onChange={event => setDraftName(event.target.value)}
              onBlur={() => void commitCharacterEdit()}
              onKeyDown={event => {
                if (event.key === 'Enter') void commitCharacterEdit();
                if (event.key === 'Escape') cancelCharacterEdit();
              }}
              onClick={event => event.stopPropagation()}
              className="h-7 min-w-0 flex-1 text-xs"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{character.name}</span>
          )}
          <StatusBadge status={character.status} />
          {!isEditing && (
            <div className={cn(
              'flex items-center transition-opacity group-hover/character:opacity-100 group-focus-within/character:opacity-100',
              isActive ? 'opacity-100' : 'opacity-0',
            )}>
              {projectId && (
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    derivativeTriggerRef.current = event.currentTarget;
                    setDerivativeSource(character);
                  }}
                  aria-label={`为 ${character.name} 创建衍生`}
                  className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Layers2 className="size-4" aria-hidden />
                </button>
              )}
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation();
                  setDeleteTarget(character);
                }}
                aria-label={`删除角色 ${character.name}`}
                className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
          )}
        </li>
    );
  }
}

function CharacterAvatar({ name, thumbnail, active }: {
  name: string;
  thumbnail?: string | null;
  active: boolean;
}) {
  if (thumbnail) {
    return (
      <img
        src={`/api/gallery/image?path=${encodeURIComponent(thumbnail)}`}
        alt=""
        className={cn(
          'size-7 shrink-0 rounded-sm border border-border object-cover',
          active && 'ring-1 ring-primary/60',
        )}
      />
    );
  }
  return (
    <span aria-hidden className={cn(
      'grid size-7 shrink-0 place-items-center rounded-sm border border-border bg-card text-sm font-medium text-muted-foreground',
      active && 'ring-1 ring-primary/60',
    )}>
      {name.slice(0, 1) || '·'}
    </span>
  );
}

function StatusBadge({ status }: { status: CharacterEntry['status'] }) {
  if (status === 'idle') {
    return <span className="size-2 shrink-0 rounded-full border border-muted-foreground/25" />;
  }
  const colorClass: Record<string, string> = {
    pending: 'bg-[color:var(--status-pending)]',
    running: 'animate-pulse bg-[color:var(--status-running)]',
    pending_confirm: 'bg-[color:var(--status-running)]',
    done: 'bg-[color:var(--status-done)]',
    failed: 'bg-[color:var(--status-failed)]',
  };
  return <span className={cn('size-2 shrink-0 rounded-full', colorClass[status] || 'bg-muted-foreground/40')} />;
}
