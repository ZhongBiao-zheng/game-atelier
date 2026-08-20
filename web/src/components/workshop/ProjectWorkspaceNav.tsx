import { Film, Images, LayoutDashboard, PanelsTopLeft } from 'lucide-react';
import { Link } from 'wouter';

import { cn } from '@/lib/utils';

export type WorkshopWorkspace = 'overview' | 'art' | 'ui' | 'video';

const WORKSPACES = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'art', label: '美术', icon: Images },
  { id: 'ui', label: 'UI', icon: PanelsTopLeft },
  { id: 'video', label: '视频', icon: Film },
] satisfies Array<{
  id: WorkshopWorkspace;
  label: string;
  icon: typeof LayoutDashboard;
}>;

export function ProjectWorkspaceNav({
  projectId,
  workspace,
}: {
  projectId: string;
  workspace: WorkshopWorkspace;
}) {
  return (
    <nav aria-label="项目工作区" className="flex max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-glass p-1 backdrop-blur-glass">
      {WORKSPACES.map(({ id, label, icon: Icon }) => (
        <Link
          key={id}
          href={`/workshop/${encodeURIComponent(projectId)}/${id}`}
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
