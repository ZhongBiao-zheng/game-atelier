import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroupInput } from '@/components/ui/input-group';
import { chooseFolder } from '@/api/folders';
import { listCanvasProjects } from '@/api/canvas';
import { fetchProfile, mountTeamLibrary, saveProfile } from '@/api/teamLibraries';
import type { TeamLibraryView } from '@/schema/teamLibrary';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export interface ProjectOption {
  project_id: string;
  name: string;
}

/** 带搜索的项目勾选列表：挂载弹窗与设置页「+ 项目」共用。 */
export function ProjectChecklist({ projects, selected, onToggle, disabled, tags, className }: {
  projects: ProjectOption[];
  selected: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  disabled?: boolean;
  /** 行尾的灰字标注，如「当前画布」。 */
  tags?: Record<string, string>;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter(project => project.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);
  return <div className={cn('overflow-hidden rounded-md border border-border bg-popover', className)}>
    <Label className="flex h-10 items-center gap-2 border-b border-border px-3 text-muted-foreground">
      <Search className="size-3.5 shrink-0" aria-hidden />
      <InputGroupInput type="search" aria-label="搜索项目" placeholder="搜索项目" value={query} onChange={event => setQuery(event.target.value)}
        className="px-0" />
    </Label>
    <div className="max-h-60 overflow-y-auto p-1">
      {visible.map(project => <Label key={project.project_id}
        className={cn('flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm hover:bg-secondary/60',
          !selected.has(project.project_id) && 'text-muted-foreground', disabled && 'pointer-events-none opacity-50')}>
        <Checkbox checked={selected.has(project.project_id)}
          disabled={disabled} onCheckedChange={() => onToggle(project.project_id)} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {tags?.[project.project_id] && <span className="shrink-0 text-xs text-muted-foreground">{tags[project.project_id]}</span>}
      </Label>)}
      {visible.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的项目</p>}
    </div>
  </div>;
}

/** 挂载团队库：选文件夹、没署名时补署名、勾选要挂到的项目。设置页、画布团队栏、分享弹窗共用。 */
export function MountTeamLibraryDialog({ open, currentProjectId, onClose, onMounted }: {
  open: boolean;
  /** 从画布打开时预先勾上并标注「当前画布」。 */
  currentProjectId?: string;
  onClose: () => void;
  onMounted: (views: TeamLibraryView[]) => void;
}) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [needsName, setNeedsName] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPath(null);
    setDisplayName('');
    setNeedsName(false);
    setError(null);
    setSelected(new Set(currentProjectId ? [currentProjectId] : []));
    const fail = (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); };
    void listCanvasProjects(true).then(list => {
      if (cancelled) return;
      if (!Array.isArray(list)) {
        console.error('画布项目列表返回格式不对', list);
        throw new Error('读取画布项目失败：返回格式不对');
      }
      setProjects(currentProjectId
        ? [...list.filter(p => p.project_id === currentProjectId), ...list.filter(p => p.project_id !== currentProjectId)]
        : list);
    }).catch(fail);
    void fetchProfile().then(profile => { if (!cancelled) setNeedsName(!profile.display_name); }).catch(fail);
    return () => { cancelled = true; };
  }, [open, currentProjectId]);

  async function pick() {
    setError(null);
    try {
      const picked = await chooseFolder('选择团队库文件夹', path ?? undefined);
      if (picked) setPath(picked);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function submit() {
    if (!path || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const done: TeamLibraryView[] = [];
    try {
      if (needsName) {
        await saveProfile(displayName.trim());
        setNeedsName(false);
      }
      for (const projectId of projects.map(p => p.project_id).filter(id => selected.has(id))) {
        done.push(await mountTeamLibrary({ projectId, path }));
      }
      onMounted(done);
      onClose();
    } catch (cause) {
      if (done.length) onMounted(done);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const canSubmit = Boolean(path) && selected.size > 0 && (!needsName || Boolean(displayName.trim())) && !busy;
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>挂载文件夹</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">文件夹</p>
          <Button variant="bare" type="button" onClick={() => void pick()} disabled={busy}
            className="flex h-11 w-full items-center gap-2.5 rounded-md border border-input pl-3 pr-1.5 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', !path && 'font-sans text-sm text-muted-foreground')}>{path ?? '选择文件夹'}</span>
            {path && <span className="rounded-sm bg-secondary px-2.5 py-1.5 text-xs">更换</span>}
          </Button>
        </div>
        {needsName && <Label className="block space-y-2">
          <span className="text-xs text-muted-foreground">署名</span>
          <Input value={displayName} placeholder="分享时显示的名字" maxLength={40} disabled={busy}
            onChange={event => setDisplayName(event.target.value)} />
        </Label>}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>挂到项目</span>{selected.size > 0 && <span>已选 {selected.size}</span>}
          </div>
          <ProjectChecklist projects={projects} selected={selected} disabled={busy}
            tags={currentProjectId ? { [currentProjectId]: '当前画布' } : undefined}
            onToggle={id => setSelected(current => {
              const next = new Set(current);
              if (!next.delete(id)) next.add(id);
              return next;
            })} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
          {selected.size > 0 ? `挂载到 ${selected.size} 个项目` : '挂载'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
