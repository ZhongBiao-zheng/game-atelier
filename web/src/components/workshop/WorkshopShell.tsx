import { ChevronRight } from 'lucide-react';
import { Link } from 'wouter';

import type { Project } from '@/schema/jobs';
import {
  ProjectWorkspaceNav,
} from '@/components/workshop/ProjectWorkspaceNav';
import {
  getWorkspaceDescriptor,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';
import {
  useWorkshopReturn,
  workshopFolderPath,
} from '@/lib/workshopReturn';

export function WorkshopShell({
  project,
  workspace,
  objectLabel,
  sectionLabel,
  children,
}: {
  project?: Project | null;
  workspace?: WorkshopWorkspace;
  objectLabel?: string | null;
  sectionLabel?: string;
  children: React.ReactNode;
}) {
  const returnContext = useWorkshopReturn();
  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border/40 px-4 py-3 md:px-6">
        <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Link
            href="/workshop"
            className="shrink-0 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            全部项目
          </Link>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden />
          {project ? (
            <>
              <Link
                href={`/workshop/${encodeURIComponent(project.id)}/overview`}
                className="min-w-0 truncate rounded-sm text-foreground/85 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {project.name}
              </Link>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden />
              <span className="shrink-0" aria-current={objectLabel ? undefined : 'page'}>
                {sectionLabel ?? (workspace ? getWorkspaceDescriptor(workspace).label : '文件夹')}
              </span>
            </>
          ) : (
            <span className="shrink-0" aria-current={objectLabel ? undefined : 'page'}>未分类角色</span>
          )}
          {objectLabel && (
            <>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden />
              <span className="min-w-0 truncate text-foreground/85" aria-current="page">
                {objectLabel}
              </span>
            </>
          )}
        </nav>

        {project && (
          <div className="mt-3 flex min-w-0 items-center gap-3">
            {returnContext && (
              <Link
                href={workshopFolderPath(project.id, returnContext)}
                className="shrink-0 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                返回文件夹
              </Link>
            )}
            <ProjectWorkspaceNav projectId={project.id} workspace={workspace} />
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
