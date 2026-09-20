import { useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { chooseFolder } from '@/api/folders';
import { fetchProjects } from '@/api/projects';
import {
  ProfileRequiredError,
  listTeamLibraries,
  mountTeamLibrary,
  rescanTeamLibrary,
  unmountTeamLibrary,
} from '@/api/teamLibraries';
import type { Project } from '@/schema/jobs';
import type { TeamLibraryView } from '@/schema/teamLibrary';

const SYNC_HINT = '目录由团队自己的 SVN / Git / 网盘同步；这里只登记本机路径';

const rowButton =
  'rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export function TeamLibrariesSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [libraries, setLibraries] = useState<TeamLibraryView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUnmount, setPendingUnmount] = useState<TeamLibraryView | null>(null);

  useEffect(() => {
    fetchProjects()
      .then(file => {
        // 服务端载荷缺字段时按空列表处理：本节是设置页的一个子块，不该拖垮整页。
        const list = Array.isArray(file?.projects) ? file.projects : [];
        setProjects(list);
        setProjectId(current => current || list[0]?.id || '');
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const reload = useCallback(async (id: string) => {
    if (!id) {
      setLibraries([]);
      return;
    }
    try {
      const views = await listTeamLibraries(id);
      setLibraries(Array.isArray(views) ? views : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload(projectId);
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
          aria-label="项目"
          value={projectId}
          onChange={event => setProjectId(event.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {projects.map(project => (
            <option key={project.id} value={project.id}>
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
