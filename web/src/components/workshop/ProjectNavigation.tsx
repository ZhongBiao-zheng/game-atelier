import { Check, ChevronsUpDown, LibraryBig, Plus } from 'lucide-react';
import { Link } from 'wouter';

import type { CharacterEntry, Project } from '@/schema/jobs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  getWorkspaceDescriptor,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';

export function ProjectNavigation({
  project,
  projects,
  workspace,
  characters,
  onNavigate,
  onNewCharacter,
  renderCharacter,
}: {
  project: Project;
  projects: Project[];
  workspace: WorkshopWorkspace;
  characters: CharacterEntry[];
  onNavigate?: () => void;
  onNewCharacter: () => void;
  renderCharacter: (character: CharacterEntry) => React.ReactNode;
}) {
  const projectBase = `/workshop/${encodeURIComponent(project.id)}`;
  const overview = getWorkspaceDescriptor('overview');
  const art = getWorkspaceDescriptor('art');
  const ui = getWorkspaceDescriptor('ui');
  const video = getWorkspaceDescriptor('video');
  const currentWorkspace = workspace;

  return (
    <nav aria-label={`${project.name} 项目导航`} className="space-y-4">
      <ProjectSwitcher
        project={project}
        projects={projects}
        onNavigate={onNavigate}
      />

      <ProjectSideLink
        projectBase={projectBase}
        descriptor={overview}
        current={currentWorkspace === overview.id}
        onNavigate={onNavigate}
      />

      <section aria-labelledby="asset-library-heading" className="space-y-1">
        <h2
          id="asset-library-heading"
          className="flex h-8 items-center gap-2 px-2.5 text-xs font-medium uppercase tracking-label text-muted-foreground/70"
        >
          <LibraryBig className="size-4" aria-hidden />
          资产库
        </h2>
        <div className="flex items-center gap-1">
          <ProjectSideLink
            projectBase={projectBase}
            descriptor={art}
            current={currentWorkspace === art.id}
            onNavigate={onNavigate}
            className="min-w-0 flex-1"
          />
          {workspace === 'art' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onNewCharacter}
              aria-label="新建角色"
              title="新建角色"
              className="size-10 shrink-0"
            >
              <Plus className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        {workspace === 'art' && (
          <ul className="m-0 list-none space-y-0.5 p-0 pl-2">
            {characters.map(renderCharacter)}
          </ul>
        )}
        <ProjectSideLink
          projectBase={projectBase}
          descriptor={ui}
          current={currentWorkspace === ui.id}
          onNavigate={onNavigate}
        />
        <ProjectSideLink
          projectBase={projectBase}
          descriptor={video}
          current={currentWorkspace === video.id}
          onNavigate={onNavigate}
        />
      </section>
    </nav>
  );
}

function ProjectSwitcher({
  project,
  projects,
  onNavigate,
}: {
  project: Project;
  projects: Project[];
  onNavigate?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 w-full justify-between gap-3 px-3 py-2 text-left"
          aria-label={`切换项目，当前为 ${project.name}`}
        >
          <span className="min-w-0">
            <span className="block text-xs font-normal text-muted-foreground">当前项目</span>
            <span className="block whitespace-normal break-words text-sm font-medium text-foreground">
              {project.name}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        <DropdownMenuLabel>切换项目</DropdownMenuLabel>
        {projects.map(candidate => (
          <DropdownMenuItem key={candidate.id} asChild>
            <Link
              href={`/workshop/${encodeURIComponent(candidate.id)}/overview`}
              onClick={onNavigate}
              aria-current={candidate.id === project.id ? 'page' : undefined}
            >
              <Check className={cn('size-4', candidate.id !== project.id && 'invisible')} aria-hidden />
              <span className="whitespace-normal break-words">{candidate.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/workshop" onClick={onNavigate}>
            <LibraryBig className="size-4" aria-hidden />
            全部项目
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectSideLink({
  projectBase,
  descriptor,
  current,
  onNavigate,
  className,
}: {
  projectBase: string;
  descriptor: ReturnType<typeof getWorkspaceDescriptor>;
  current: boolean;
  onNavigate?: () => void;
  className?: string;
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
        className,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 whitespace-normal break-words">{descriptor.sidebarLabel}</span>
    </Link>
  );
}
