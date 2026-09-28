import { useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useSearch } from 'wouter';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { chooseFolder } from '@/api/folders';
import { listCanvasProjects } from '@/api/canvas';
import {
  ProfileRequiredError,
  listTeamLibraries,
  mountTeamLibrary,
  rescanTeamLibrary,
  unmountTeamLibrary,
} from '@/api/teamLibraries';
import type { CanvasProject } from '@/schema/canvas';
import type { TeamLibraryView } from '@/schema/teamLibrary';

const SYNC_HINT = '目录由团队自己的 SVN / Git / 网盘同步；这里只登记本机路径';

const BAD_PAYLOAD = '读取列表失败：返回格式不对';

const rowButton =
  'rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export function TeamLibrariesSection() {
  const search = useSearch();
  // 从画布 / 创作台团队栏的「挂载」跳来时带 ?canvas=<id>：只在首次载入时用作默认选中。
  const [requestedCanvas] = useState(() => new URLSearchParams(search).get('canvas'));
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [libraries, setLibraries] = useState<TeamLibraryView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUnmount, setPendingUnmount] = useState<TeamLibraryView | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 团队库挂在画布项目上：Studio 与画布的团队栏都按画布项目 ID 查挂载。
    listCanvasProjects(true)
      .then(list => {
        if (cancelled) return;
        // 载荷不合契约不静默退化成空列表——那样「读失败」和「真的没有」长得一模一样。
        if (!Array.isArray(list)) {
          console.error('画布项目列表返回格式不对', list);
          setError(BAD_PAYLOAD);
          return;
        }
        setProjects(list);
        const requested = list.find(project => project.project_id === requestedCanvas);
        setProjectId(current => current || requested?.project_id || list[0]?.project_id || '');
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [requestedCanvas]);

  const reload = useCallback(async (id: string, cancelled?: () => boolean) => {
    const dropped = () => cancelled?.() ?? false;
    if (!id) {
      if (!dropped()) setLibraries([]);
      return;
    }
    try {
      const views = await listTeamLibraries(id);
      if (dropped()) return;
      if (!Array.isArray(views)) {
        console.error('团队库列表返回格式不对', views);
        setLibraries([]);
        setError(BAD_PAYLOAD);
        return;
      }
      setLibraries(views);
    } catch (e) {
      if (!dropped()) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void reload(projectId, () => cancelled);
    return () => { cancelled = true; };
  }, [projectId, reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload(projectId);
    } catch (e) {
      if (e instanceof ProfileRequiredError) setError('先设置显示名');
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function mount() {
    const picked = await chooseFolder('选择团队库文件夹');
    if (!picked) return;
    await run(() => mountTeamLibrary({ projectId, path: picked, name: undefined }));
  }

  return (
    <>
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs uppercase tracking-label text-muted-foreground/70">团队库</h2>
          <button
            type="button"
            title={SYNC_HINT}
            aria-label={SYNC_HINT}
            className="text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <HelpCircle className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
      <div className="min-w-0 space-y-3">
        <select
          aria-label="画布项目"
          value={projectId}
          onChange={event => setProjectId(event.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {projects.map(project => (
            <option key={project.project_id} value={project.project_id}>
              {project.name}
            </option>
          ))}
        </select>

        <ul className="space-y-2">
          {libraries.map(library => (
            <li
              key={library.library_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">{library.name}</span>
                  {!library.reachable && (
                    <span className="text-xs uppercase tracking-label text-destructive">不可达</span>
                  )}
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground/70">
                  {library.mount_path}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">{library.asset_count} 项</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => rescanTeamLibrary(library.library_id))}
                  className={rowButton}
                >
                  扫描
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingUnmount(library)}
                  className={rowButton}
                >
                  卸载
                </button>
              </div>
            </li>
          ))}
        </ul>

        <button
          type="button"
          disabled={busy || !projectId}
          onClick={() => void mount()}
          className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          挂载
        </button>

        {error && <div className="text-sm text-destructive">{error}</div>}
      </div>

      {pendingUnmount && (
        <ConfirmDialog
          open
          variant="destructive"
          title="卸载团队库"
          message={pendingUnmount.name}
          detail={pendingUnmount.mount_path}
          onCancel={() => setPendingUnmount(null)}
          onConfirm={() => {
            const target = pendingUnmount;
            setPendingUnmount(null);
            void run(() => unmountTeamLibrary(target.library_id, projectId));
          }}
        />
      )}
    </>
  );
}
