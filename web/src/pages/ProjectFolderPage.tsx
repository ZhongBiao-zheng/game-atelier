import { useEffect, useMemo, useState } from 'react';
import { Film, Folder, Images, PanelsTopLeft, Plus, Save, Trash2, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';

import {
  addProjectFolderItem,
  deleteProjectFolder,
  fetchProjectFolders,
  notifyProjectFoldersChanged,
  removeProjectFolderItem,
  updateProjectFolder,
  type ProjectFolder,
  type ProjectFolderItem,
  type ProjectFolderItemKind,
  type ProjectFoldersFile,
} from '@/api/projectFolders';
import { fetchGalleryScreens, type ProjectScreenItem } from '@/api/gallery';
import { fetchProjectVideos, type ProjectVideoProduction } from '@/api/videos';
import { fetchProjectWorkspaces, type ProjectWorkspaceSummary } from '@/api/workspaces';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { CharacterEntry, ProjectsFile } from '@/schema/jobs';
import {
  WORKSPACE_DESCRIPTORS,
  type WorkshopWorkspace,
} from '@/components/workshop/workspaces';

export type ProjectFolderView = WorkshopWorkspace;

const KIND_VIEW: Record<ProjectFolderItemKind, ProjectFolderView> = {
  character: 'art',
  ui_screen: 'ui',
  video_production: 'video',
};

const KIND_LABEL: Record<ProjectFolderItemKind, string> = {
  character: '角色',
  ui_screen: 'UI 页面',
  video_production: '视频企划',
};

interface ResolvedAsset extends ProjectFolderItem {
  label: string;
  href: string;
}

export function ProjectFolderPage({
  projectId,
  folderId,
  view,
  onFolderChange,
}: {
  projectId: string;
  folderId: string;
  view: ProjectFolderView;
  onFolderChange: (folder: ProjectFolder | null) => void;
}) {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<ProjectFoldersFile | null>(null);
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [projectCharacterIds, setProjectCharacterIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<ProjectWorkspaceSummary | null>(null);
  const [screenVersions, setScreenVersions] = useState<ProjectScreenItem[]>([]);
  const [productions, setProductions] = useState<ProjectVideoProduction[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const folder = file?.folders.find(candidate => candidate.id === folderId) ?? null;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchProjectFolders(projectId),
      fetch('/api/characters').then(response => response.json() as Promise<CharacterEntry[]>),
      fetch('/api/projects').then(response => response.json() as Promise<ProjectsFile>),
      fetchProjectWorkspaces(projectId),
      fetchGalleryScreens(projectId),
      fetchProjectVideos(projectId),
    ]).then(([
      foldersFile,
      characterItems,
      projectsFile,
      workspace,
      screenItems,
      videoItems,
    ]) => {
      if (cancelled) return;
      setFile(foldersFile);
      setCharacters(characterItems);
      setProjectCharacterIds(new Set(
        Object.entries(projectsFile.assignments)
          .filter(([, ownerId]) => ownerId === projectId)
          .map(([characterId]) => characterId),
      ));
      setSummary(workspace);
      setScreenVersions(screenItems);
      setProductions(videoItems);
    }).catch(errorValue => {
      if (!cancelled) setError((errorValue as Error).message);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!folder) return;
    setName(folder.name);
    setNote(folder.note);
    onFolderChange(folder);
  }, [folder?.id, folder?.name, folder?.note, onFolderChange]);

  const assets = useMemo(() => resolveAssets(projectId, folder, characters, summary, productions), [
    projectId,
    folder,
    characters,
    summary,
    productions,
  ]);
  const visibleAssets = view === 'overview'
    ? assets
    : assets.filter(asset => KIND_VIEW[asset.kind] === view);
  const candidates = useMemo(() => allCandidates(
    projectId,
    characters.filter(character => projectCharacterIds.has(character.id)),
    summary,
    screenVersions,
    productions,
  ), [
    projectId,
    characters,
    projectCharacterIds,
    summary,
    screenVersions,
    productions,
  ]).filter(candidate => !folder?.items.some(item => (
    item.kind === candidate.kind && item.asset_id === candidate.asset_id
  )));
  const visibleCandidates = view === 'overview'
    ? candidates
    : candidates.filter(candidate => KIND_VIEW[candidate.kind] === view);

  function accept(next: ProjectFoldersFile) {
    setFile(next);
    notifyProjectFoldersChanged(projectId);
  }

  async function save() {
    if (!folder || !name.trim()) return;
    try {
      accept(await updateProjectFolder(projectId, folder.id, name.trim(), note.trim()));
    } catch (errorValue) {
      setError((errorValue as Error).message);
    }
  }

  async function add(item: ProjectFolderItem) {
    if (!folder) return;
    try {
      accept(await addProjectFolderItem(projectId, folder.id, item));
    } catch (errorValue) {
      setError((errorValue as Error).message);
    }
  }

  async function remove(item: ProjectFolderItem) {
    if (!folder) return;
    try {
      accept(await removeProjectFolderItem(projectId, folder.id, item));
    } catch (errorValue) {
      setError((errorValue as Error).message);
    }
  }

  async function confirmDelete() {
    if (!folder) return;
    try {
      await deleteProjectFolder(projectId, folder.id);
      notifyProjectFoldersChanged(projectId);
      onFolderChange(null);
      setLocation(`/workshop/${encodeURIComponent(projectId)}/overview`, { replace: true });
    } catch (errorValue) {
      setDeleting(false);
      setError((errorValue as Error).message);
    }
  }

  if (!file) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">读取文件夹…</div>;
  }
  if (!folder) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">这个文件夹不存在或已删除。</div>;
  }

  return (
    <div className="h-full overflow-y-auto stable-scroll">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        <header className="space-y-4 border-b border-border/50 pb-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start">
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-label text-muted-foreground">
                <Folder className="size-4" aria-hidden />
                个人文件夹 · 只整理引用
              </div>
              <Input
                aria-label="文件夹名称"
                value={name}
                onChange={event => setName(event.target.value)}
                className="h-10 font-display text-display"
              />
              <Textarea
                aria-label="文件夹备注"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder="记录这个文件夹整理的内容"
                className="min-h-16"
              />
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => { void save(); }}
                disabled={!name.trim() || (name === folder.name && note === folder.note)}
                aria-label="保存文件夹"
              >
                <Save aria-hidden />
                保存
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden />
                删除文件夹
              </Button>
            </div>
          </div>

          <nav aria-label="文件夹视图" className="flex gap-1 overflow-x-auto">
            {WORKSPACE_DESCRIPTORS.map(item => (
              <Link
                key={item.id}
                href={`/workshop/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folder.id)}/${item.id}`}
                aria-current={view === item.id ? 'page' : undefined}
                className={cn(
                  'rounded-full px-4 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  view === item.id
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <section aria-labelledby="folder-members-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="folder-members-heading" className="text-base font-medium text-foreground">已整理内容</h2>
            <span className="text-xs text-muted-foreground">{visibleAssets.length} 项</span>
          </div>
          {visibleAssets.length > 0 ? (
            <ul className="m-0 grid list-none gap-2 p-0 md:grid-cols-2">
              {visibleAssets.map(asset => (
                <li key={`${asset.kind}:${asset.asset_id}`} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                  <AssetIcon kind={asset.kind} />
                  <Link href={asset.href} className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                    <span className="block text-xs text-muted-foreground">{KIND_LABEL[asset.kind]}</span>
                    <span className="block truncate text-sm font-medium text-foreground">{asset.label}</span>
                  </Link>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`从文件夹移除 ${asset.label}`}
                    onClick={() => { void remove(asset); }}
                    className="text-muted-foreground"
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              这个视图还没有内容。资产仍留在项目资产库中。
            </p>
          )}
        </section>

        {visibleCandidates.length > 0 && (
          <section aria-labelledby="folder-add-heading" className="space-y-3 border-t border-border/50 pt-5">
            <div>
              <h2 id="folder-add-heading" className="text-base font-medium text-foreground">从项目资产加入</h2>
              <p className="mt-1 text-xs text-muted-foreground">这里只增加引用，不复制或移动资产。</p>
            </div>
            <ul className="m-0 grid list-none gap-2 p-0 md:grid-cols-2">
              {visibleCandidates.map(candidate => (
                <li key={`${candidate.kind}:${candidate.asset_id}`} className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2">
                  <AssetIcon kind={candidate.kind} />
                  <span className="min-w-0 flex-1 truncate text-sm">{candidate.label}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`添加${KIND_LABEL[candidate.kind]} ${candidate.label}`}
                    onClick={() => { void add({ kind: candidate.kind, asset_id: candidate.asset_id }); }}
                  >
                    <Plus aria-hidden />
                    加入
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>

      <ConfirmDialog
        open={deleting}
        title={`删除文件夹「${folder.name}」？`}
        message="只删除文件夹和整理关系，不会删除资产或历史。"
        confirmText="确认删除"
        variant="destructive"
        onCancel={() => setDeleting(false)}
        onConfirm={() => { void confirmDelete(); }}
      />
    </div>
  );
}

function AssetIcon({ kind }: { kind: ProjectFolderItemKind }) {
  const className = 'size-4 shrink-0 text-muted-foreground';
  if (kind === 'character') return <Images className={className} aria-hidden />;
  if (kind === 'ui_screen') return <PanelsTopLeft className={className} aria-hidden />;
  return <Film className={className} aria-hidden />;
}

function resolveAssets(
  projectId: string,
  folder: ProjectFolder | null,
  characters: CharacterEntry[],
  summary: ProjectWorkspaceSummary | null,
  productions: ProjectVideoProduction[],
): ResolvedAsset[] {
  if (!folder) return [];
  const characterNames = new Map(characters.map(item => [item.id, item.name]));
  const screenNames = new Map(summary?.ui.screen_items.map(item => [item.screen_id, item.name]) ?? []);
  const productionNames = new Map(productions.map(item => [item.production_id, item.title]));
  return folder.items.map(item => {
    if (item.kind === 'character') return {
      ...item,
      label: characterNames.get(item.asset_id) ?? item.asset_id,
      href: `/workshop/${encodeURIComponent(projectId)}/art/characters/${encodeURIComponent(item.asset_id)}`,
    };
    if (item.kind === 'ui_screen') return {
      ...item,
      label: screenNames.get(item.asset_id) ?? item.asset_id,
      href: `/workshop/${encodeURIComponent(projectId)}/ui/screens/${encodeURIComponent(item.asset_id)}`,
    };
    return {
      ...item,
      label: productionNames.get(item.asset_id) ?? item.asset_id,
      href: `/workshop/${encodeURIComponent(projectId)}/video/${encodeURIComponent(item.asset_id)}`,
    };
  });
}

function allCandidates(
  projectId: string,
  characters: CharacterEntry[],
  summary: ProjectWorkspaceSummary | null,
  screenVersions: ProjectScreenItem[],
  productions: ProjectVideoProduction[],
): ResolvedAsset[] {
  const screenIds = new Set([
    ...(summary?.ui.screen_items.map(item => item.screen_id) ?? []),
    ...screenVersions.map(item => item.screen_id),
  ]);
  return resolveAssets(projectId, {
    id: 'candidates',
    name: '',
    note: '',
    created_at: '',
    items: [
      ...characters.map(item => ({ kind: 'character' as const, asset_id: item.id })),
      ...[...screenIds].map(screenId => ({ kind: 'ui_screen' as const, asset_id: screenId })),
      ...productions.map(item => ({ kind: 'video_production' as const, asset_id: item.production_id })),
    ],
  }, characters, summary, productions);
}
