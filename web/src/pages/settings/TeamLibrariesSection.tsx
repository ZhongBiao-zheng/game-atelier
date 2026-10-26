import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { Folder, Plus } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { chooseFolder } from '@/api/folders';
import { listCanvasProjects } from '@/api/canvas';
import { ProfileRequiredError, listTeamLibraries, mountTeamLibrary, rescanTeamLibrary, unmountTeamLibrary } from '@/api/teamLibraries';
import type { CanvasProject } from '@/schema/canvas';
import type { TeamLibraryView } from '@/schema/teamLibrary';

export const SYNC_HINT = '目录由团队自己的 SVN / Git / 网盘同步；这里只登记本机路径';
const BAD_PAYLOAD = '读取列表失败：返回格式不对';
const rowButton = 'rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function scannedAt(value: string | null) {
  if (!value) return '尚未扫描';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (!Number.isFinite(minutes)) return '尚未扫描';
  if (minutes < 1) return '刚刚扫描';
  if (minutes < 60) return `${minutes} 分钟前扫描`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前扫描`;
  return `${Math.floor(minutes / 1440)} 天前扫描`;
}

export function TeamLibrariesSection() {
  const search = useSearch();
  const [requestedCanvas] = useState(() => new URLSearchParams(search).get('canvas'));
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [mounts, setMounts] = useState<TeamLibraryView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUnmount, setPendingUnmount] = useState<TeamLibraryView | null>(null);
  const request = useRef(0);
  const reload = useCallback(async (cancelled: () => boolean = () => false) => {
    const current = ++request.current;
    let views: TeamLibraryView[];
    try { views = await listTeamLibraries(undefined, true); }
    catch (error) { if (!cancelled() && current === request.current) throw error; else return; }
    if (cancelled() || current !== request.current) return;
    if (!Array.isArray(views)) {
      console.error('团队库列表返回格式不对', views);
      throw new Error(BAD_PAYLOAD);
    }
    setMounts(views);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listCanvasProjects(true).then(list => {
      if (cancelled) return;
      if (!Array.isArray(list)) {
        console.error('画布项目列表返回格式不对', list);
        throw new Error(BAD_PAYLOAD);
      }
      setProjects(list);
      const requested = list.find(project => project.project_id === requestedCanvas);
      setProjectId(requested?.project_id || list[0]?.project_id || '');
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    void reload(() => cancelled).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [requestedCanvas, reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ProfileRequiredError ? '先设置显示名' : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }
  function mount() {
    const target = projectId;
    void run(async () => {
      const picked = await chooseFolder('选择团队库文件夹');
      if (picked) await mountTeamLibrary({ projectId: target, path: picked, name: undefined });
    });
  }
  const libraries = mounts?.filter(library => library.project_id === projectId) ?? [];
  const current = projects.find(project => project.project_id === projectId);
  return <>
    <div className="flex min-w-0 flex-col items-start gap-4 lg:flex-row">
      <nav aria-label="画布项目" className="w-full shrink-0 space-y-0.5 lg:w-60">
        <p className="mb-2 px-2.5 text-xs text-muted-foreground">画布项目</p>
        {projects.map(project => {
          const count = mounts?.filter(library => library.project_id === project.project_id).length ?? 0;
          return <button key={project.project_id} type="button" aria-pressed={projectId === project.project_id} disabled={busy}
            onClick={() => setProjectId(project.project_id)}
            className={`flex h-10 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${projectId === project.project_id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60'}`}>
            <span className="truncate">{project.name}</span>{count > 0 && <span className="shrink-0 text-xs text-muted-foreground">{count} 个</span>}
          </button>;
        })}
      </nav>
      <section aria-label="已挂载" className="min-w-0 w-full flex-1 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-semibold">{current?.name ?? '暂无画布项目'}</h2>
          <button type="button" disabled={busy || !projectId} onClick={mount}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary/60 disabled:opacity-50">
            <Plus className="size-3.5" aria-hidden />挂载文件夹
          </button>
        </div>
        {libraries.length > 0 ? <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {libraries.map(library => <li key={library.library_id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary"><Folder className="size-4" /></span>
            <div className="min-w-0 flex-1 basis-48 space-y-1">
              <p className="text-sm font-medium">{library.name}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">{library.mount_path}</p>
            </div>
            <span className={`flex items-center gap-1.5 whitespace-nowrap text-xs ${library.reachable ? 'text-muted-foreground' : 'text-destructive'}`}>
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${library.reachable ? 'bg-status-done' : 'bg-destructive'}`} />
              {library.reachable ? `${library.asset_count.toLocaleString()} 项 · ${scannedAt(library.scanned_at)}` : '路径不可达'}
            </span>
            <div className="flex shrink-0 gap-1">
              <button type="button" disabled={busy} onClick={() => void run(() => rescanTeamLibrary(library.library_id))} className={rowButton}>重新扫描</button>
              <button type="button" disabled={busy} onClick={() => setPendingUnmount(library)} className={rowButton}>卸载</button>
            </div>
          </li>)}
        </ul> : mounts && current && <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-4 py-10">
          <p className="text-sm text-muted-foreground">这个项目还没挂载团队库</p>
          <button type="button" disabled={busy} onClick={mount} className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">选择文件夹</button>
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </section>
    </div>
    {pendingUnmount && <ConfirmDialog open variant="destructive" title="卸载团队库" message={pendingUnmount.name} detail={pendingUnmount.mount_path}
      onCancel={() => setPendingUnmount(null)} onConfirm={() => {
        const target = pendingUnmount;
        setPendingUnmount(null);
        void run(() => unmountTeamLibrary(target.library_id, target.project_id));
      }} />}
  </>;
}
