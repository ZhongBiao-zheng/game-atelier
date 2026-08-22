import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, LibraryBig, Plus, Search } from 'lucide-react';
import { Link } from 'wouter';

import type { CharacterEntry, Project } from '@/schema/jobs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { fetchVisibleUiSchemes, type UiSchemesFile } from '@/api/uiSchemes';
import {
  getWorkspaceDescriptor,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';

export function ProjectNavigation({
  project,
  projects,
  workspace,
  characters,
  selectedCharacterId,
  selectedUiSchemeId,
  refreshSignal,
  onNavigate,
  onNewCharacter,
  renderCharacter,
}: {
  project: Project;
  projects: Project[];
  workspace: WorkshopWorkspace;
  characters: CharacterEntry[];
  selectedCharacterId?: string | null;
  selectedUiSchemeId?: string | null;
  refreshSignal?: number;
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
  const charactersExpandedKey = `workshop:characters-expanded:${project.id}`;
  const uiExpandedKey = `workshop:ui-expanded:${project.id}`;
  const recentKey = `workshop:recent-characters:${project.id}`;
  const [charactersExpanded, toggleCharacters] = usePersistentDisclosure(
    charactersExpandedKey,
    workspace === 'art',
  );
  const [uiExpanded, toggleUi] = usePersistentDisclosure(uiExpandedKey, workspace === 'ui');
  const [query, setQuery] = useState('');
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecent(recentKey));
  const [uiSchemes, setUiSchemes] = useState<UiSchemesFile | null>(null);
  const visibleSchemes = Array.isArray(uiSchemes?.schemes) ? uiSchemes.schemes : [];
  const hasVisibleUiSchemes = visibleSchemes.length > 0;
  const navigationScheme = visibleSchemes.find(
    scheme => scheme.id === uiSchemes?.default_scheme_id,
  ) ?? visibleSchemes[0];
  const uiSchemeId = selectedUiSchemeId ?? navigationScheme?.id;
  const uiHref = uiSchemeId
    ? `${projectBase}/ui/${encodeURIComponent(uiSchemeId)}`
    : `${projectBase}/ui`;

  useEffect(() => {
    setQuery('');
    setRecentIds(readRecent(recentKey));
  }, [recentKey]);

  useEffect(() => {
    let cancelled = false;
    fetchVisibleUiSchemes(project.id)
      .then(value => { if (!cancelled) setUiSchemes(value); })
      .catch(() => { if (!cancelled) setUiSchemes(null); });
    return () => { cancelled = true; };
  }, [project.id, refreshSignal]);

  useEffect(() => {
    if (!selectedCharacterId || !characters.some(item => item.id === selectedCharacterId)) return;
    setRecentIds(current => {
      const next = [selectedCharacterId, ...current.filter(id => id !== selectedCharacterId)].slice(0, 20);
      window.localStorage.setItem(recentKey, JSON.stringify(next));
      return next;
    });
  }, [characters, recentKey, selectedCharacterId]);

  const visibleCharacters = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle) return characters.filter(item => item.name.toLocaleLowerCase().includes(needle));
    const byId = new Map(characters.map(item => [item.id, item]));
    return recentIds
      .map(id => byId.get(id))
      .filter((item): item is CharacterEntry => Boolean(item))
      .slice(0, 5);
  }, [characters, query, recentIds]);

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
          <ProjectSideDisclosureLink
            descriptor={art}
            current={currentWorkspace === art.id}
            expanded={charactersExpanded}
            onToggle={toggleCharacters}
            href={`${projectBase}/art`}
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
        {charactersExpanded && (
          <div className="space-y-2 pl-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label="搜索侧栏角色"
                placeholder="搜索角色"
                className="h-8 pl-8 text-xs"
              />
            </label>
            <ul className="m-0 list-none space-y-0.5 p-0">
              {visibleCharacters.map(renderCharacter)}
            </ul>
            <Link
              href={`${projectBase}/art`}
              onClick={onNavigate}
              className="block rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              查看全部角色
            </Link>
          </div>
        )}
        <ProjectSideDisclosureLink
          descriptor={ui}
          current={currentWorkspace === ui.id}
          expanded={hasVisibleUiSchemes && uiExpanded}
          onToggle={() => { if (hasVisibleUiSchemes) toggleUi(); }}
          href={uiHref}
          onNavigate={onNavigate}
        />
        {hasVisibleUiSchemes && uiExpanded && (
          <ul className="m-0 list-none space-y-0.5 pl-4 pr-0 pt-1">
            {visibleSchemes.map(scheme => {
              const isDefault = scheme.id === uiSchemes?.default_scheme_id;
              const isCurrent = currentWorkspace === 'ui' && uiSchemeId === scheme.id;
              return (
                <li key={scheme.id}>
                  <Link
                    href={`${projectBase}/ui/${encodeURIComponent(scheme.id)}`}
                    onClick={onNavigate}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={cn(
                      'flex min-h-9 items-center justify-between gap-2 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      isCurrent
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    <span className="min-w-0 truncate">{scheme.name}</span>
                    {isDefault && <span className="shrink-0 text-xs text-primary">默认</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
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

function usePersistentDisclosure(key: string, defaultExpanded: boolean) {
  const [expanded, setExpanded] = useState(() => readDisclosure(key, defaultExpanded));

  useEffect(() => {
    setExpanded(readDisclosure(key, defaultExpanded));
  }, [defaultExpanded, key]);

  function toggle() {
    setExpanded(value => {
      const next = !value;
      window.localStorage.setItem(key, String(next));
      return next;
    });
  }

  return [expanded, toggle] as const;
}

function readDisclosure(key: string, fallback: boolean) {
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
}

function ProjectSideDisclosureLink({
  descriptor,
  current,
  expanded,
  onToggle,
  href,
  onNavigate,
  className,
}: {
  descriptor: ReturnType<typeof getWorkspaceDescriptor>;
  current: boolean;
  expanded: boolean;
  onToggle: () => void;
  href: string;
  onNavigate?: () => void;
  className?: string;
}) {
  const Icon = descriptor.icon;
  return (
    <Link
      href={href}
      onClick={() => {
        onToggle();
        onNavigate?.();
      }}
      aria-current={current ? 'page' : undefined}
      aria-expanded={expanded}
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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

function readRecent(key: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
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
