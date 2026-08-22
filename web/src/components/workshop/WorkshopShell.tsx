import { ChevronRight } from 'lucide-react';
import { Link } from 'wouter';

import type { Project } from '@/schema/jobs';
import {
  getWorkspaceDescriptor,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';

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
                {sectionLabel ?? (workspace ? getWorkspaceDescriptor(workspace).label : '项目')}
              </span>
            </>
          ) : (
            <span className="shrink-0" aria-current={objectLabel ? undefined : 'page'}>角色资产</span>
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
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
