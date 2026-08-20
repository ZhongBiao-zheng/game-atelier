import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Folder, FolderPlus } from 'lucide-react';
import { Link } from 'wouter';

import {
  createProjectFolder,
  fetchProjectFolders,
  listenForProjectFoldersChanged,
  notifyProjectFoldersChanged,
  reorderProjectFolders,
  type ProjectFolder,
} from '@/api/projectFolders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function ProjectFoldersNavigation({
  projectId,
  currentFolderId,
  onNavigate,
}: {
  projectId: string;
  currentFolderId?: string;
  onNavigate?: () => void;
}) {
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchProjectFolders(projectId)
        .then(file => { if (!cancelled) setFolders(file.folders); })
        .catch(errorValue => { if (!cancelled) setError((errorValue as Error).message); });
    };
    load();
    const stop = listenForProjectFoldersChanged(projectId, load);
    return () => { cancelled = true; stop(); };
  }, [projectId]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    try {
      const file = await createProjectFolder(projectId, trimmed);
      setFolders(file.folders);
      setName('');
      setCreating(false);
      notifyProjectFoldersChanged(projectId);
    } catch (errorValue) {
      setError((errorValue as Error).message);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= folders.length) return;
    const ordered = [...folders];
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    try {
      const file = await reorderProjectFolders(projectId, ordered.map(folder => folder.id));
      setFolders(file.folders);
      notifyProjectFoldersChanged(projectId);
    } catch (errorValue) {
      setError((errorValue as Error).message);
    }
  }

  return (
    <section aria-labelledby="project-folders-heading" className="space-y-1">
      <div className="flex h-9 items-center gap-2 px-2.5">
        <Folder className="size-4 text-muted-foreground" aria-hidden />
        <h2 id="project-folders-heading" className="flex-1 text-sm font-medium text-foreground">
          文件夹
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="新建文件夹"
          className="size-7 text-muted-foreground"
          onClick={() => setCreating(true)}
        >
          <FolderPlus aria-hidden />
        </Button>
      </div>
      {creating && (
        <Input
          ref={inputRef}
          aria-label="新文件夹名称"
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={() => { void create(); }}
          onKeyDown={event => {
            if (event.key === 'Enter') void create();
            if (event.key === 'Escape') { setCreating(false); setName(''); }
          }}
          placeholder="例如：夏日版本"
          className="h-8 text-xs"
        />
      )}
      <ul className="m-0 list-none space-y-0.5 p-0">
        {folders.map((folder, index) => (
          <li key={folder.id} className="group flex items-center gap-1">
            <Link
              href={`/workshop/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folder.id)}/overview`}
              onClick={onNavigate}
              aria-current={currentFolderId === folder.id ? 'page' : undefined}
              className={cn(
                'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                currentFolderId === folder.id
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Folder className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{folder.name}</span>
            </Link>
            <div className="flex shrink-0 items-center min-[769px]:hidden min-[769px]:group-hover:flex min-[769px]:group-focus-within:flex">
              <button
                type="button"
                aria-label={`上移文件夹 ${folder.name}`}
                disabled={index === 0}
                onClick={() => { void move(index, -1); }}
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronUp className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`下移文件夹 ${folder.name}`}
                disabled={index === folders.length - 1}
                onClick={() => { void move(index, 1); }}
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronDown className="size-3.5" aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="px-2.5 text-xs text-destructive">{error}</p>}
    </section>
  );
}
