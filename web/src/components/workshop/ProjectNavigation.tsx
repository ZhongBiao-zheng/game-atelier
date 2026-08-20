import { Folder, LibraryBig } from 'lucide-react';
import { Link } from 'wouter';

import type { CharacterEntry, Project } from '@/schema/jobs';
import { cn } from '@/lib/utils';
import {
  getWorkspaceDescriptor,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';
import { SidebarDropZone } from '@/components/workshop/SidebarDropZone';

export function ProjectNavigation({
  project,
  workspace,
  characters,
  dragOver,
  onDrop,
  onDragOver,
  onDragLeave,
  onNavigate,
  renderCharacter,
}: {
  project: Project;
  workspace: WorkshopWorkspace;
  characters: CharacterEntry[];
  dragOver: boolean;
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onNavigate?: () => void;
  renderCharacter: (character: CharacterEntry) => React.ReactNode;
}) {
  const projectBase = `/workshop/${encodeURIComponent(project.id)}`;
  const overview = getWorkspaceDescriptor('overview');
  const art = getWorkspaceDescriptor('art');
  const ui = getWorkspaceDescriptor('ui');
  const video = getWorkspaceDescriptor('video');

  return (
    <nav aria-label={`${project.name} 项目导航`} className="space-y-3">
      <div className="space-y-1">
        <Link
          href="/workshop"
          onClick={onNavigate}
          className="flex h-10 items-center gap-2 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <LibraryBig className="size-4" aria-hidden />
          全部项目
        </Link>
        <p className="truncate px-2.5 pt-2 text-xs font-medium uppercase tracking-label text-muted-foreground/70">
          {project.name}
        </p>
        <ProjectSideLink
          projectBase={projectBase}
          descriptor={overview}
          current={workspace === overview.id}
          onNavigate={onNavigate}
        />
        <div
          aria-disabled="true"
          className="flex h-10 items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground/65"
        >
          <Folder className="size-4" aria-hidden />
          <span className="flex-1">文件夹</span>
          <span className="text-xs">待接入</span>
        </div>
      </div>

      <section aria-labelledby="asset-library-heading" className="space-y-1">
        <h2
          id="asset-library-heading"
          className="flex h-8 items-center gap-2 px-2.5 text-xs font-medium uppercase tracking-label text-muted-foreground/70"
        >
          <LibraryBig className="size-4" aria-hidden />
          资产库
        </h2>
        <ProjectSideLink
          projectBase={projectBase}
          descriptor={art}
          current={workspace === art.id}
          onNavigate={onNavigate}
        />
        {workspace === 'art' && (
          <SidebarDropZone
            label="角色名册"
            active={dragOver}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
          >
            <ul className="m-0 list-none p-0">
              {characters.map(renderCharacter)}
            </ul>
          </SidebarDropZone>
        )}
        <ProjectSideLink
          projectBase={projectBase}
          descriptor={ui}
          current={workspace === ui.id}
          onNavigate={onNavigate}
        />
        <ProjectSideLink
          projectBase={projectBase}
          descriptor={video}
          current={workspace === video.id}
          onNavigate={onNavigate}
        />
      </section>
    </nav>
  );
}

function ProjectSideLink({
  projectBase,
  descriptor,
  current,
  onNavigate,
}: {
  projectBase: string;
  descriptor: ReturnType<typeof getWorkspaceDescriptor>;
  current: boolean;
  onNavigate?: () => void;
}) {
  const Icon = descriptor.icon;
  return (
    <Link
      href={`${projectBase}/${descriptor.id}`}
      onClick={onNavigate}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex h-10 items-center gap-2 rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        current
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden />
      {descriptor.sidebarLabel}
    </Link>
  );
}
