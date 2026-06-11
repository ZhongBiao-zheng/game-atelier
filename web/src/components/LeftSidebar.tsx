import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, X, AlertCircle, FolderPlus, UserPlus, GripVertical } from 'lucide-react';
import type { CharacterEntry, Project, ProjectsFile } from '../schema/jobs';
import { useActiveCharacter } from '../hooks/useActiveCharacter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Props {
  sseSignal: number;
  selectedId?: string | null;
  onSelect: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
}

const UNCATEGORIZED = '__uncategorized__';
const DRAG_PROJECT = 'text/project-id';
const DRAG_CHAR = 'text/character-id';

export function LeftSidebar({ sseSignal, selectedId, onSelect, onDelete }: Props) {
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [projects, setProjects] = useState<ProjectsFile>({ projects: [], assignments: {} });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // project folder reorder
  const [projectDragId, setProjectDragId] = useState<string | null>(null);
  const [projectDragOver, setProjectDragOver] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingCharacter, setCreatingCharacter] = useState(false);
  const [newCharacterName, setNewCharacterName] = useState('');
  const activeId = useActiveCharacter(sseSignal);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const newProjectInputRef = useRef<HTMLInputElement | null>(null);
  const newCharInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then(setCharacters);
    fetch('/api/projects').then(r => r.json()).then(setProjects);
  }, [sseSignal]);

  useEffect(() => {
    if ((editingId || editingProjectId) && inputRef.current) inputRef.current.select();
  }, [editingId, editingProjectId]);

  useEffect(() => {
    if (creatingProject && newProjectInputRef.current) newProjectInputRef.current.focus();
  }, [creatingProject]);

  useEffect(() => {
    if (creatingCharacter && newCharInputRef.current) newCharInputRef.current.focus();
  }, [creatingCharacter]);

  function startCharEdit(c: CharacterEntry, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingProjectId(null);
    setEditingId(c.id);
    setDraftName(c.name);
    setError(null);
  }

  function startProjectEdit(p: Project, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(null);
    setEditingProjectId(p.id);
    setDraftName(p.name);
    setError(null);
  }

  async function commitCharEdit() {
    if (!editingId) return;
    const name = draftName.trim();
    if (!name) { cancelEdit(); return; }
    const original = characters.find(c => c.id === editingId);
    if (original && name === original.name) { cancelEdit(); return; }
    try {
      const r = await fetch(`/api/characters/${editingId}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${r.status}`);
      }
      setCharacters(cs => cs.map(c => c.id === editingId ? { ...c, name } : c));
      cancelEdit();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function commitProjectEdit() {
    if (!editingProjectId) return;
    const name = draftName.trim();
    if (!name) { cancelEdit(); return; }
    const original = projects.projects.find(p => p.id === editingProjectId);
    if (original && name === original.name) { cancelEdit(); return; }
    try {
      const r = await fetch(`/api/projects/${editingProjectId}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${r.status}`);
      }
      const updated = await r.json();
      setProjects(updated);
      cancelEdit();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingProjectId(null);
    setDraftName('');
  }

  function startNewProject() {
    setCreatingProject(true);
    setNewProjectName('');
    setError(null);
  }

  function cancelNewProject() {
    setCreatingProject(false);
    setNewProjectName('');
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
    if (!name) { cancelNewCharacter(); return; }
    try {
      const r = await fetch('/api/characters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const entry = await r.json() as { id: string; name: string };
      cancelNewCharacter();
      onSelect(entry.id, entry.name);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function commitNewProject() {
    const name = newProjectName.trim();
    if (!name) { cancelNewProject(); return; }
    try {
      const r = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProjects(await r.json());
      cancelNewProject();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteProject(p: Project, e: React.MouseEvent) {
    e.stopPropagation();
    const members = Object.entries(projects.assignments).filter(([, pid]) => pid === p.id).length;
    const ok = window.confirm(
      members > 0
        ? `删除项目「${p.name}」？里面的 ${members} 个角色会回到"未分类"，角色文件不会丢。`
        : `删除项目「${p.name}」？`,
    );
    if (!ok) return;
    try {
      const r = await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProjects(await r.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCharacter(c: CharacterEntry, e: React.MouseEvent) {
    e.stopPropagation();
    const ok = window.confirm(
      `删除角色「${c.name}」？\n角色目录和其中图片会从磁盘删除，不可恢复。`,
    );
    if (!ok) return;
    try {
      const r = await fetch(`/api/characters/${c.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCharacters(cs => cs.filter(item => item.id !== c.id));
      setProjects(ps => ({
        ...ps,
        assignments: Object.fromEntries(
          Object.entries(ps.assignments).filter(([id]) => id !== c.id),
        ),
      }));
      onDelete?.(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function assignTo(characterId: string, projectId: string | null) {
    try {
      const r = await fetch(`/api/characters/${characterId}/project`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${r.status}`);
      }
      setProjects(await r.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function onDragStart(e: React.DragEvent, characterId: string) {
    e.dataTransfer.setData(DRAG_CHAR, characterId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDrop(e: React.DragEvent, target: string) {
    e.preventDefault();
    setDragOver(null);
    const cid = e.dataTransfer.getData(DRAG_CHAR);
    if (!cid) return;
    const current = projects.assignments[cid] || UNCATEGORIZED;
    if (current === target) return;
    void assignTo(cid, target === UNCATEGORIZED ? null : target);
  }

  function onDragOver(e: React.DragEvent, target: string) {
    if (e.dataTransfer.types.includes(DRAG_CHAR)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(target);
    }
  }

  function onProjectDragStart(e: React.DragEvent, projectId: string) {
    e.dataTransfer.setData(DRAG_PROJECT, projectId);
    e.dataTransfer.effectAllowed = 'move';
    setProjectDragId(projectId);
  }

  function onProjectDragOver(e: React.DragEvent, targetId: string, el: HTMLElement) {
    if (!e.dataTransfer.types.includes(DRAG_PROJECT)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const pos: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setProjectDragOver({ id: targetId, pos });
  }

  function onProjectDrop(e: React.DragEvent, targetId: string, el: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const dragId = e.dataTransfer.getData(DRAG_PROJECT);
    setProjectDragId(null);
    setProjectDragOver(null);
    if (!dragId || dragId === targetId) return;
    const rect = el.getBoundingClientRect();
    const pos: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const list = projects.projects.filter(p => p.id !== dragId);
    const idx = list.findIndex(p => p.id === targetId);
    if (idx === -1) return;
    list.splice(pos === 'before' ? idx : idx + 1, 0, projects.projects.find(p => p.id === dragId)!);
    setProjects(ps => ({ ...ps, projects: list }));
    void fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ordered_ids: list.map(p => p.id) }),
    });
  }

  function onProjectDragEnd() {
    setProjectDragId(null);
    setProjectDragOver(null);
  }

  const grouped = new Map<string, CharacterEntry[]>();
  for (const p of projects.projects) grouped.set(p.id, []);
  grouped.set(UNCATEGORIZED, []);
  for (const c of characters) {
    const key = projects.assignments[c.id] && grouped.has(projects.assignments[c.id])
      ? projects.assignments[c.id]
      : UNCATEGORIZED;
    grouped.get(key)!.push(c);
  }

  if (characters.length === 0 && projects.projects.length === 0) {
    return (
      <aside className="h-full border-r border-border/60 bg-card/30 flex flex-col">
        <BrandHeader
          onNewCharacter={startNewCharacter}
          onNewProject={startNewProject}
          creatingCharacter={creatingCharacter}
          creatingProject={creatingProject}
        />
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 text-center gap-4">
          <p className="font-display text-display italic text-foreground/70">尚无作品</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            在终端 Claude Code<br />
            输入"开始角色工作流"开始建档
          </p>
          {creatingCharacter ? (
            <div className="flex items-center gap-1.5 w-full max-w-[180px]">
              <Input
                ref={newCharInputRef}
                value={newCharacterName}
                onChange={e => setNewCharacterName(e.target.value)}
                onBlur={commitNewCharacter}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitNewCharacter();
                  if (e.key === 'Escape') cancelNewCharacter();
                }}
                placeholder="角色名（如：烈拳猴）"
                className="h-7 text-xs"
              />
            </div>
          ) : (
            <Button variant="outline" size="sm" className="mt-2" onClick={startNewCharacter}>
              <Plus className="size-3.5" />
              新建角色
            </Button>
          )}
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="h-full border-r border-border/60 bg-card/30 flex flex-col">
      <BrandHeader
        onNewCharacter={startNewCharacter}
        onNewProject={startNewProject}
        creatingCharacter={creatingCharacter}
        creatingProject={creatingProject}
      />

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {creatingCharacter && (
          <div className="mb-2 flex items-center gap-1.5 px-2 py-1">
            <UserPlus className="size-3.5 text-muted-foreground shrink-0" />
            <Input
              ref={newCharInputRef}
              value={newCharacterName}
              onChange={e => setNewCharacterName(e.target.value)}
              onBlur={commitNewCharacter}
              onKeyDown={e => {
                if (e.key === 'Enter') commitNewCharacter();
                if (e.key === 'Escape') cancelNewCharacter();
              }}
              placeholder="角色名（如：烈拳猴）"
              className="h-7 text-xs"
            />
          </div>
        )}
        {creatingProject && (
          <section className="mb-2 flex items-center gap-1.5 px-2 py-1">
            <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
            <Input
              ref={newProjectInputRef}
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onBlur={commitNewProject}
              onKeyDown={e => {
                if (e.key === 'Enter') commitNewProject();
                if (e.key === 'Escape') cancelNewProject();
              }}
              placeholder="项目名（如：魔幻 / 武侠）"
              className="h-7 text-xs"
            />
          </section>
        )}

        {projects.projects.map(p => (
          <ProjectGroup
            key={p.id} project={p} chars={grouped.get(p.id) || []}
            isEditing={editingProjectId === p.id} draftName={draftName}
            dragOver={dragOver === p.id} onDrop={onDrop} onDragOver={onDragOver}
            onDragLeave={() => setDragOver(null)}
            onRenameStart={startProjectEdit} onRenameChange={setDraftName}
            onRenameCommit={commitProjectEdit} onRenameCancel={cancelEdit}
            onDelete={deleteProject} inputRef={inputRef}
            renderChar={c => renderChar(c)}
            isDragging={projectDragId === p.id}
            dropIndicator={projectDragOver?.id === p.id ? projectDragOver.pos : null}
            onProjectDragStart={onProjectDragStart}
            onProjectDragOver={onProjectDragOver}
            onProjectDrop={onProjectDrop}
            onProjectDragEnd={onProjectDragEnd}
          />
        ))}

        <DropZone
          label={projects.projects.length > 0 ? '未分类' : null}
          active={dragOver === UNCATEGORIZED}
          onDrop={e => onDrop(e, UNCATEGORIZED)}
          onDragOver={e => onDragOver(e, UNCATEGORIZED)}
          onDragLeave={() => setDragOver(null)}
        >
          <ul className="list-none m-0 p-0">
            {(grouped.get(UNCATEGORIZED) || []).map(renderChar)}
          </ul>
        </DropZone>

        {error && (
          <div className="mt-3 mx-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertCircle className="size-3 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </aside>
  );

  function renderChar(c: CharacterEntry) {
    const isActive = c.id === (selectedId ?? activeId);
    const isEditing = c.id === editingId;
    return (
      <li
        key={c.id}
        draggable={!isEditing}
        onDragStart={(e) => onDragStart(e, c.id)}
        onClick={() => !isEditing && onSelect(c.id, c.name)}
        onDoubleClick={(e) => startCharEdit(c, e)}
        onKeyDown={(e) => {
          if (isEditing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(c.id, c.name);
          }
        }}
        role={isEditing ? undefined : 'button'}
        tabIndex={isEditing ? undefined : 0}
        aria-label={isEditing ? undefined : c.name}
        aria-pressed={isEditing ? undefined : isActive}
        title="双击重命名 · 拖到项目"
        className={cn(
          'group/char flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          isEditing ? 'cursor-text' : 'cursor-pointer',
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'text-foreground/85 hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <StatusBadge status={c.status} isActive={isActive} />
        {isEditing ? (
          <Input
            ref={inputRef}
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onBlur={commitCharEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitCharEdit();
              if (e.key === 'Escape') cancelEdit();
            }}
            onClick={e => e.stopPropagation()}
            className="h-6 text-xs flex-1 bg-background/20 border-background/30"
          />
        ) : (
          <span className="flex-1 truncate">{c.name}</span>
        )}
        {!isEditing && (
          <button
            onClick={(e) => deleteCharacter(c, e)}
            aria-label={`删除角色 ${c.name}`}
            title="删除角色（磁盘也会删）"
            className={cn(
              'grid place-items-center size-6 rounded bg-transparent border-0 p-0 cursor-pointer opacity-0 transition-opacity group-hover/char:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive',
              isActive
                ? 'text-primary-foreground/75 hover:bg-primary-foreground/15 hover:text-primary-foreground'
                : 'text-muted-foreground hover:bg-destructive/15 hover:text-destructive',
            )}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </li>
    );
  }
}

interface ProjectGroupProps {
  project: Project;
  chars: CharacterEntry[];
  isEditing: boolean;
  draftName: string;
  dragOver: boolean;
  onDrop: (e: React.DragEvent, target: string) => void;
  onDragOver: (e: React.DragEvent, target: string) => void;
  onDragLeave: () => void;
  onRenameStart: (p: Project, e: React.MouseEvent) => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: (p: Project, e: React.MouseEvent) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  renderChar: (c: CharacterEntry) => React.ReactNode;
  isDragging: boolean;
  dropIndicator: 'before' | 'after' | null;
  onProjectDragStart: (e: React.DragEvent, id: string) => void;
  onProjectDragOver: (e: React.DragEvent, id: string, el: HTMLElement) => void;
  onProjectDrop: (e: React.DragEvent, id: string, el: HTMLElement) => void;
  onProjectDragEnd: () => void;
}

function ProjectGroup({
  project, chars, isEditing, draftName, dragOver,
  onDrop, onDragOver, onDragLeave,
  onRenameStart, onRenameChange, onRenameCommit, onRenameCancel,
  onDelete, inputRef, renderChar,
  isDragging, dropIndicator,
  onProjectDragStart, onProjectDragOver, onProjectDrop, onProjectDragEnd,
}: ProjectGroupProps) {
  const [open, setOpen] = useState(true);
  const sectionRef = useRef<HTMLElement>(null);
  return (
    <section
      ref={sectionRef}
      draggable={!isEditing}
      onDragStart={e => onProjectDragStart(e, project.id)}
      onDragEnd={onProjectDragEnd}
      onDrop={e => {
        if (e.dataTransfer.types.includes(DRAG_PROJECT) && sectionRef.current) {
          onProjectDrop(e, project.id, sectionRef.current);
        } else {
          onDrop(e, project.id);
        }
      }}
      onDragOver={e => {
        if (e.dataTransfer.types.includes(DRAG_PROJECT) && sectionRef.current) {
          onProjectDragOver(e, project.id, sectionRef.current);
        } else {
          onDragOver(e, project.id);
        }
      }}
      onDragLeave={onDragLeave}
      className={cn(
        'mb-1.5 rounded-md transition-colors relative',
        dragOver && !isDragging && 'bg-primary/5 ring-2 ring-primary/30 ring-inset',
        isDragging && 'opacity-40',
        dropIndicator === 'before' && 'border-t-2 border-primary',
        dropIndicator === 'after' && 'border-b-2 border-primary',
      )}
    >
      <header className="group/header flex items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground select-none">
        <span
          title="拖动排序"
          className="grid place-items-center size-4 cursor-grab text-muted-foreground/40 hover:text-muted-foreground shrink-0"
          onMouseDown={e => e.stopPropagation()}
        >
          <GripVertical className="size-3" />
        </span>
        <button
          onClick={() => !isEditing && setOpen(o => !o)}
          aria-label={open ? '收起项目' : '展开项目'}
          title={open ? '收起' : '展开'}
          className="grid place-items-center size-4 rounded hover:bg-accent/60 cursor-pointer bg-transparent border-0 p-0 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        {isEditing ? (
          <Input
            ref={inputRef}
            value={draftName}
            onChange={e => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={e => {
              if (e.key === 'Enter') onRenameCommit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={e => e.stopPropagation()}
            className="h-6 text-xs flex-1"
          />
        ) : (
          <span
            onClick={() => setOpen(o => !o)}
            onDoubleClick={(e) => onRenameStart(project, e)}
            title="双击重命名"
            className="flex-1 font-semibold text-foreground cursor-pointer truncate"
          >
            {project.name}
          </span>
        )}
        <span className="text-xs tabular-nums text-muted-foreground/70 px-1">
          {chars.length}
        </span>
        <button
          onClick={(e) => onDelete(project, e)}
          aria-label={`删除项目 ${project.name}`}
          title="删除项目（角色不会丢）"
          className="grid place-items-center size-4 rounded hover:bg-destructive/15 hover:text-destructive cursor-pointer opacity-0 group-hover/header:opacity-100 transition-opacity bg-transparent border-0 p-0 text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
        >
          <X className="size-3" />
        </button>
      </header>
      {open && (
        <ul className="list-none m-0 p-0 pl-2">
          {chars.length > 0
            ? chars.map(renderChar)
            : <li className="px-2.5 py-1.5 text-xs text-muted-foreground/70 italic">空 —— 把角色拖进来</li>}
        </ul>
      )}
    </section>
  );
}

function DropZone({ label, active, onDrop, onDragOver, onDragLeave, children }: {
  label: string | null; active: boolean;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={cn(
        'rounded-md transition-colors',
        active && 'bg-primary/5 ring-2 ring-primary/30 ring-inset',
      )}
    >
      {label && (
        <header className="px-1.5 py-1 text-xs text-muted-foreground select-none">
          {label}
        </header>
      )}
      {children}
    </section>
  );
}

function StatusBadge({ status, isActive }: { status: CharacterEntry['status']; isActive: boolean }) {
  if (status === 'idle') {
    return <span className={cn('size-2 rounded-full shrink-0 border', isActive ? 'border-primary-foreground/40 bg-transparent' : 'border-muted-foreground/25 bg-transparent')} />;
  }
  const colorClass: Record<string, string> = {
    pending: 'bg-[color:var(--status-pending)]',
    running: 'bg-[color:var(--status-running)] animate-pulse',
    pending_confirm: 'bg-[color:var(--status-running)]',
    done: 'bg-[color:var(--status-done)]',
    failed: 'bg-[color:var(--status-failed)]',
  };
  return <span className={cn('size-2 rounded-full shrink-0', colorClass[status] || 'bg-muted-foreground/40')} />;
}

function BrandHeader({
  onNewCharacter,
  onNewProject,
  creatingCharacter,
  creatingProject,
}: {
  onNewCharacter: () => void;
  onNewProject: () => void;
  creatingCharacter: boolean;
  creatingProject: boolean;
}) {
  return (
    <header className="flex items-center justify-between px-5 py-4 border-b border-border/60">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewCharacter}
          disabled={creatingCharacter}
          title="新建角色"
          className="h-9 px-3 text-sm"
        >
          <UserPlus className="size-4" />
          新角色
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNewProject}
          disabled={creatingProject}
          title="新建项目（用来给角色分类）"
          className="h-9 px-3 text-sm"
        >
          <FolderPlus className="size-4" />
          新项目
        </Button>
      </div>
    </header>
  );
}
