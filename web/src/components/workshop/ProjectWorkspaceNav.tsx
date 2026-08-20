import { Link } from 'wouter';

import { cn } from '@/lib/utils';
import {
  WORKSPACE_DESCRIPTORS,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';
import { useWorkshopReturn, withWorkshopReturn } from '@/lib/workshopReturn';

export type { WorkshopWorkspace } from '@/components/workshop/workspaces';

export function ProjectWorkspaceNav({
  projectId,
  workspace,
}: {
  projectId: string;
  workspace?: WorkshopWorkspace;
}) {
  const returnContext = useWorkshopReturn();
  return (
    <nav aria-label="项目工作区" className="flex max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-glass p-1 backdrop-blur-glass">
      {WORKSPACE_DESCRIPTORS.map(({ id, label, icon: Icon }) => (
        <Link
          key={id}
          href={withWorkshopReturn(`/workshop/${encodeURIComponent(projectId)}/${id}`, returnContext)}
          aria-current={workspace === id ? 'page' : undefined}
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            workspace === id
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
