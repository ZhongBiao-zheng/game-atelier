import {
  Download,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderTree,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import {
  adoptTeamAsset,
  listTeamAssets,
  listTeamLibraries,
  rescanTeamLibrary,
  teamAssetThumbUrl,
} from '@/api/teamLibraries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  TEAM_ASSET_DRAG_TYPE,
  type TeamAssetAdoptResponse,
  type TeamLibraryIndexEntry,
  type TeamLibraryView,
} from '@/schema/teamLibrary';

export interface TeamLibraryPanelProps {
  projectId: string;
  /** 采用完成后交给调用方：由它决定提示与后续动作。 */
  onAdopted: (result: TeamAssetAdoptResponse, entry: TeamLibraryIndexEntry) => void;
  /** 没有挂载库时的「挂载」出口。 */
  onOpenSettings: () => void;
  className?: string;
}

/** 类型筛选：图片 / 视频 / 音频按 mime 前缀在前端过滤，提示词走服务端 kind。 */
type TypeFilter = 'all' | 'image' | 'video' | 'audio' | 'prompt';

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'prompt', label: '提示词' },
];

/** 目录树节点：原始文件按挂载点下第一级目录，分享内容按作者。 */
type TreeNode = { group: 'dir' | 'author'; name: string };

const ROOT_DIR = '根目录';
const NO_AUTHOR = '未署名';

function nodeOf(entry: TeamLibraryIndexEntry): TreeNode {
  if (entry.kind === 'raw') {
    const [head, ...rest] = entry.relative_path.split('/');
    return { group: 'dir', name: rest.length > 0 ? head : ROOT_DIR };
  }
  return { group: 'author', name: entry.author ?? NO_AUTHOR };
}

function sameNode(a: TreeNode, b: TreeNode): boolean {
  return a.group === b.group && a.name === b.name;
}

function matchesType(entry: TeamLibraryIndexEntry, filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'prompt') return entry.kind === 'prompt';
  return (entry.mime_type ?? '').startsWith(`${filter}/`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function TypeIcon({ entry, className }: { entry: TeamLibraryIndexEntry; className?: string }) {
  const mime = entry.mime_type ?? '';
  if (entry.kind === 'prompt') return <FileText className={className} />;
  if (mime.startsWith('video/')) return <FileVideo className={className} />;
  if (mime.startsWith('audio/')) return <FileAudio className={className} />;
  return <FileImage className={className} />;
}

export function TeamLibraryPanel({
  projectId,
  onAdopted,
  onOpenSettings,
  className,
}: TeamLibraryPanelProps) {
  const [libraries, setLibraries] = useState<TeamLibraryView[]>([]);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [node, setNode] = useState<TreeNode | null>(null);
  const [entries, setEntries] = useState<TeamLibraryIndexEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const library = useMemo(
    () => libraries.find(item => item.library_id === libraryId) ?? null,
    [libraries, libraryId],
  );

  useEffect(() => {
    let alive = true;
    void listTeamLibraries(projectId)
      .then(list => {
        if (!alive) return;
        setLibraries(list);
        setLibraryId(current =>
          current && list.some(item => item.library_id === current)
            ? current
            : list[0]?.library_id ?? null,
        );
      })
      .catch(() => { if (alive) setLibraries([]); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!libraryId) {
      setEntries([]);
      setCursor(null);
      return;
    }
    const token = ++requestId.current;
    setError(null);
    void listTeamAssets(libraryId, {
      ...(typeFilter === 'prompt' ? { kind: 'prompt' as const } : {}),
      ...(search ? { q: search } : {}),
    })
      .then(page => {
        if (token !== requestId.current) return;
        setEntries(page.entries);
        setCursor(page.next_cursor);
      })
      .catch(() => {
        if (token !== requestId.current) return;
        setEntries([]);
        setCursor(null);
        setError('读取失败');
      });
  }, [libraryId, search, typeFilter]);

  const loadMore = useCallback(() => {
    if (!libraryId || !cursor) return;
    const token = requestId.current;
    setBusy(true);
    void listTeamAssets(libraryId, {
      ...(typeFilter === 'prompt' ? { kind: 'prompt' as const } : {}),
      ...(search ? { q: search } : {}),
      cursor,
    })
      .then(page => {
        if (token !== requestId.current) return;
        setEntries(current => [...current, ...page.entries]);
        setCursor(page.next_cursor);
      })
      .catch(() => { if (token === requestId.current) setError('读取失败'); })
      .finally(() => setBusy(false));
  }, [cursor, libraryId, search, typeFilter]);

  const rescan = useCallback(() => {
    if (!libraryId) return;
    setBusy(true);
    void rescanTeamLibrary(libraryId)
      .then(view => {
        setLibraries(current =>
          current.map(item => (item.library_id === view.library_id ? view : item)),
        );
        requestId.current += 1;
        return listTeamAssets(view.library_id, {
          ...(typeFilter === 'prompt' ? { kind: 'prompt' as const } : {}),
          ...(search ? { q: search } : {}),
        }).then(page => {
          setEntries(page.entries);
          setCursor(page.next_cursor);
        });
      })
      .catch(() => setError('扫描失败'))
      .finally(() => setBusy(false));
  }, [libraryId, search, typeFilter]);

  const adopt = useCallback(
    (entry: TeamLibraryIndexEntry) => {
      if (!libraryId) return;
      setBusy(true);
      void adoptTeamAsset(libraryId, entry.id, projectId)
        .then(result => onAdopted(result, entry))
        .catch(() => setError('采用失败'))
        .finally(() => setBusy(false));
    },
    [libraryId, onAdopted, projectId],
  );

  const typed = useMemo(
    () => entries.filter(entry => matchesType(entry, typeFilter)),
    [entries, typeFilter],
  );

  const tree = useMemo(() => {
    const seen = new Map<string, TreeNode>();
    for (const entry of typed) {
      const item = nodeOf(entry);
      seen.set(`${item.group}:${item.name}`, item);
    }
    return [...seen.values()].sort(
      (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
    );
  }, [typed]);

  const visible = useMemo(
    () => (node ? typed.filter(entry => sameNode(nodeOf(entry), node)) : typed),
    [node, typed],
  );

  if (libraries.length === 0) {
    return (
      <div className={cn('grid place-items-center gap-3 p-8 text-center', className)}>
        <p className="text-xs text-muted-foreground">这个项目还没有团队库</p>
        <Button size="sm" variant="outline" onClick={onOpenSettings}>挂载</Button>
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-3 p-3', className)}>
      <div className="flex items-center gap-2">
        {libraries.length === 1 ? (
          <span className="truncate text-sm font-medium">{libraries[0].name}</span>
        ) : (
          <select
            aria-label="团队库"
            value={libraryId ?? ''}
            onChange={event => { setNode(null); setLibraryId(event.target.value); }}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {libraries.map(item => (
              <option key={item.library_id} value={item.library_id}>{item.name}</option>
            ))}
          </select>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label="重新扫描"
          title="重新扫描挂载目录，更新可见内容"
          disabled={busy}
          onClick={rescan}
        >
          <RefreshCw />
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索"
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TYPE_FILTERS.map(item => (
          <button
            key={item.value}
            type="button"
            aria-pressed={typeFilter === item.value}
            onClick={() => { setNode(null); setTypeFilter(item.value); }}
            className={cn(
              'rounded-full border border-transparent px-3 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
              typeFilter === item.value && 'border-border bg-secondary text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {library && !library.reachable ? (
        <p className="py-8 text-center text-xs text-muted-foreground">目录不可达</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="w-40 shrink-0 space-y-1 overflow-y-auto">
            <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
              <FolderTree className="size-3.5" />目录
            </p>
            {tree.map(item => (
              <button
                key={`${item.group}:${item.name}`}
                type="button"
                aria-pressed={node ? sameNode(node, item) : false}
                onClick={() => setNode(current => (current && sameNode(current, item) ? null : item))}
                className={cn(
                  'block w-full truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                  node && sameNode(node, item) && 'bg-secondary text-foreground',
                )}
              >
                {item.name}
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto">
            {error && <p className="mb-2 text-xs text-muted-foreground">{error}</p>}
            {visible.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">库里还没有内容</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
                {visible.map(entry => (
                  <TeamAssetCard
                    key={entry.id}
                    entry={entry}
                    libraryId={library?.library_id ?? ''}
                    busy={busy}
                    onAdopt={adopt}
                  />
                ))}
              </div>
            )}
            {cursor && (
              <div className="pt-3 text-center">
                <Button size="sm" variant="outline" disabled={busy} onClick={loadMore}>更多</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamAssetCard({
  entry,
  libraryId,
  busy,
  onAdopt,
}: {
  entry: TeamLibraryIndexEntry;
  libraryId: string;
  busy: boolean;
  onAdopt: (entry: TeamLibraryIndexEntry) => void;
}) {
  const [broken, setBroken] = useState(false);
  const incomplete = entry.status === 'incomplete';
  const showThumb = !broken && (entry.mime_type ?? '').startsWith('image/');

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(
      TEAM_ASSET_DRAG_TYPE,
      JSON.stringify({ library_id: libraryId, entry_id: entry.id }),
    );
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={cn(
        'rounded-lg border border-border bg-card p-2',
        incomplete && 'opacity-50',
      )}
    >
      {showThumb ? (
        <img
          src={teamAssetThumbUrl(libraryId, entry.id, 256)}
          alt=""
          onError={() => setBroken(true)}
          className="aspect-square w-full rounded-md bg-secondary object-cover"
        />
      ) : (
        <div className="grid aspect-square w-full place-items-center rounded-md bg-secondary text-muted-foreground">
          <TypeIcon entry={entry} className="size-5" />
        </div>
      )}
      <p className="mt-2 truncate text-xs" title={entry.title}>{entry.title}</p>
      {entry.author && (
        <p className="truncate text-xs text-muted-foreground">{entry.author} · {formatBytes(entry.bytes)}</p>
      )}
      <div className="mt-1 flex items-center justify-between gap-1">
        {incomplete ? (
          <span className="text-xs text-muted-foreground">同步中</span>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAdopt(entry)}>
            <Download />采用
          </Button>
        )}
      </div>
    </div>
  );
}
