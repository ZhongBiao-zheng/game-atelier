import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Copy, Folder, FolderOpen, FolderX, MoreHorizontal, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MountTeamLibraryDialog, ProjectChecklist, type ProjectOption } from '@/components/team/MountTeamLibraryDialog';
import { chooseFolder } from '@/api/folders';
import { listCanvasProjects } from '@/api/canvas';
import { ProfileRequiredError, fetchProfile, listTeamLibraries, mountTeamLibrary, rescanTeamLibrary, saveProfile, unmountTeamLibrary } from '@/api/teamLibraries';
import type { TeamLibraryView } from '@/schema/teamLibrary';
import { cn } from '@/lib/utils';

export const SYNC_HINT = '目录由团队自己的 SVN / Git / 网盘同步；这里只登记本机路径';
const BAD_PAYLOAD = '读取列表失败：返回格式不对';
const iconButton = 'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function scannedAt(value: string | null) {
  if (!value) return '尚未扫描';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (!Number.isFinite(minutes)) return '尚未扫描';
  if (minutes < 1) return '刚刚扫描';
  if (minutes < 60) return `${minutes} 分钟前扫描`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前扫描`;
  return `${Math.floor(minutes / 1440)} 天前扫描`;
}

/** 一个团队库在本机的全部挂载：接口按（项目, 库）各返回一行，这里按库合并。 */
interface LibraryGroup {
  library: TeamLibraryView;
  projectIds: string[];
}

function groupByLibrary(views: TeamLibraryView[]): LibraryGroup[] {
  const groups = new Map<string, LibraryGroup>();
  for (const view of views) {
    const group = groups.get(view.library_id);
    if (group) group.projectIds.push(view.project_id);
    else groups.set(view.library_id, { library: view, projectIds: [view.project_id] });
  }
  return [...groups.values()];
}

function message(cause: unknown) {
  return cause instanceof ProfileRequiredError ? '先设置署名' : cause instanceof Error ? cause.message : String(cause);
}

/** 署名就地改：挂载与分享都要求先有署名，碰到缺署名时由调用方直接打开。 */
function SignatureControl({ value, open, onOpenChange, onSaved }: {
  value: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setDraft(value ?? ''); setError(null); } }, [open, value]);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const profile = await saveProfile(draft.trim());
      onSaved(profile.display_name ?? draft.trim());
      onOpenChange(false);
    } catch (cause) { setError(message(cause)); } finally { setSaving(false); }
  }
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger asChild>
      <button type="button"
        className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-xs text-muted-foreground hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:border-primary/60">
        署名<span className={cn('text-sm', value && 'text-foreground')}>{value || '未设置'}</span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content align="end" sideOffset={6} aria-label="署名"
        className="popover-in z-50 w-64 space-y-2 rounded-xl border border-border bg-card p-3">
        <form autoComplete="off" className="flex gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
          <Input autoFocus value={draft} maxLength={40} placeholder="分享时显示的名字" aria-label="署名"
            onChange={event => setDraft(event.target.value)} />
          <Button type="submit" disabled={saving || !draft.trim()}>保存</Button>
        </form>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function checkedList<T>(value: T[]): T[] {
  if (!Array.isArray(value)) {
    console.error('团队库设置页返回格式不对', value);
    throw new Error(BAD_PAYLOAD);
  }
  return value;
}

export function TeamLibrariesSection() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [mounts, setMounts] = useState<TeamLibraryView[] | null>(null);
  const [displayName, setDisplayName] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountOpen, setMountOpen] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [pendingUnmount, setPendingUnmount] = useState<LibraryGroup | null>(null);

  const request = useRef(0);
  // 先发后到的旧响应不许覆盖新列表（初始加载慢、挂载后的刷新先回来）。
  const reload = useCallback(async (cancelled: () => boolean = () => false) => {
    const current = ++request.current;
    let views: TeamLibraryView[];
    try { views = await listTeamLibraries(undefined, true); }
    catch (cause) { if (!cancelled() && current === request.current) throw cause; else return; }
    if (cancelled() || current !== request.current) return;
    setMounts(checkedList(views));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fail = (cause: unknown) => { if (!cancelled) setError(message(cause)); };
    void listCanvasProjects(true).then(list => { if (!cancelled) setProjects(checkedList(list)); }).catch(fail);
    void reload(() => cancelled).catch(fail);
    void fetchProfile().then(profile => { if (!cancelled) setDisplayName(profile.display_name); }).catch(() => {});
    return () => { cancelled = true; };
  }, [reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof ProfileRequiredError) setSignatureOpen(true);
    } finally {
      await reload().catch(cause => setError(message(cause)));
      setBusy(false);
    }
  }

  function toggleProject(group: LibraryGroup, projectId: string) {
    const { library } = group;
    void run(() => group.projectIds.includes(projectId)
      ? unmountTeamLibrary(library.library_id, projectId)
      : mountTeamLibrary({ projectId, path: library.mount_path }));
  }

  /** 库搬了位置：用新路径挂回原来的项目；选中的若是另一个库，旧库从这些项目卸掉。 */
  function relocate(group: LibraryGroup) {
    const { library } = group;
    void run(async () => {
      const picked = await chooseFolder('重新定位团队库', library.mount_path);
      if (!picked) return;
      for (const projectId of group.projectIds) {
        const view = await mountTeamLibrary({ projectId, path: picked });
        if (view.library_id !== library.library_id) await unmountTeamLibrary(library.library_id, projectId);
      }
    });
  }

  const groups = useMemo(() => groupByLibrary(mounts ?? []), [mounts]);
  const projectName = useMemo(() => new Map(projects.map(project => [project.project_id, project.name])), [projects]);
  const nameOf = (projectId: string) => projectName.get(projectId) ?? projectId;

  return <>
    <div className="flex items-center justify-end gap-2">
      {displayName !== undefined && <SignatureControl value={displayName} open={signatureOpen} onOpenChange={setSignatureOpen}
        onSaved={name => { setDisplayName(name); setError(null); }} />}
      <Button type="button" disabled={busy || projects.length === 0} onClick={() => setMountOpen(true)}>
        <Plus aria-hidden />挂载文件夹
      </Button>
    </div>

    {mounts && groups.length === 0 && <div className="flex min-h-80 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-input px-4 py-12">
      <span aria-hidden className="grid size-12 place-items-center rounded-lg bg-popover text-muted-foreground"><FolderOpen className="size-5" /></span>
      <div className="space-y-1.5 text-center">
        <p className="text-sm font-medium">还没有团队库</p>
        <p className="text-xs text-muted-foreground">选一个团队用 SVN / Git / 网盘同步的文件夹</p>
      </div>
    </div>}

    {groups.length > 0 && <ul aria-label="团队库" className="space-y-3">
      {groups.map(group => {
        const { library } = group;
        const FolderIcon = library.reachable ? Folder : FolderX;
        return <li key={library.library_id} aria-label={library.name}
          className={cn('overflow-hidden rounded-lg border bg-card', library.reachable ? 'border-border' : 'border-destructive/40')}>
          <div className="flex items-center gap-3.5 p-4">
            <span aria-hidden className={cn('grid size-10 shrink-0 place-items-center rounded-md',
              library.reachable ? 'bg-secondary' : 'bg-destructive/10 text-destructive')}>
              <FolderIcon className="size-4.5" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <p className="text-sm font-medium">{library.name}</p>
                <span className={cn('flex items-center gap-1.5 whitespace-nowrap text-xs', library.reachable ? 'text-muted-foreground' : 'text-destructive')}>
                  <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', library.reachable ? 'bg-status-done' : 'bg-destructive')} />
                  {library.reachable ? `${library.asset_count.toLocaleString()} 项 · ${scannedAt(library.scanned_at)}` : '路径不可达'}
                </span>
              </div>
              <p title={library.mount_path} className="truncate font-mono text-xs text-muted-foreground">{library.mount_path}</p>
            </div>
            {library.reachable
              ? <button type="button" aria-label="重新扫描" title="重新扫描" disabled={busy} className={iconButton}
                onClick={() => void run(() => rescanTeamLibrary(library.library_id))}>
                <RotateCw className="size-4" aria-hidden />
              </button>
              : <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => relocate(group)}>重新定位</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="更多" disabled={busy} className={iconButton}><MoreHorizontal className="size-4" aria-hidden /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(library.mount_path)}><Copy className="size-4 text-muted-foreground" aria-hidden />复制路径</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => relocate(group)}><Folder className="size-4 text-muted-foreground" aria-hidden />重新定位</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setPendingUnmount(group)}>
                  <Trash2 className="size-4" aria-hidden />从全部项目卸载
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
            <span className="mr-1.5 text-xs text-muted-foreground">挂到</span>
            {group.projectIds.map(projectId => <span key={projectId}
              className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-secondary pl-2.5 pr-1 text-xs">
              {nameOf(projectId)}
              <button type="button" aria-label={`从 ${nameOf(projectId)} 卸载`} disabled={busy}
                onClick={() => toggleProject(group, projectId)}
                className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <X className="size-3" aria-hidden />
              </button>
            </span>)}
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" disabled={busy || !library.reachable}
                  className="inline-flex h-7 items-center gap-1 rounded-sm border border-dashed border-input px-2.5 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:border-solid data-[state=open]:border-primary/60 data-[state=open]:text-foreground">
                  <Plus className="size-3" aria-hidden />项目
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content align="start" sideOffset={6} aria-label={`${library.name} 挂到的项目`}
                  className="popover-in z-50 w-72">
                  <ProjectChecklist className="rounded-xl" disabled={busy} selected={new Set(group.projectIds)} onToggle={id => toggleProject(group, id)}
                    projects={projects} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </li>;
      })}
    </ul>}

    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <MountTeamLibraryDialog open={mountOpen} onClose={() => setMountOpen(false)}
      onMounted={() => {
        void reload().catch(cause => setError(message(cause)));
        void fetchProfile().then(profile => setDisplayName(profile.display_name)).catch(() => {});
      }} />
    {pendingUnmount && <ConfirmDialog open variant="destructive" title="从全部项目卸载" message={pendingUnmount.library.name}
      detail={pendingUnmount.library.mount_path} confirmText="卸载"
      onCancel={() => setPendingUnmount(null)} onConfirm={() => {
        const target = pendingUnmount;
        setPendingUnmount(null);
        void run(async () => {
          for (const projectId of target.projectIds) await unmountTeamLibrary(target.library.library_id, projectId);
        });
      }} />}
  </>;
}
