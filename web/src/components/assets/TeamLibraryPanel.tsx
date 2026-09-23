import {
  Copy,
  Download,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderTree,
  Pencil,
  RefreshCw,
  Search,
  Undo2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';

import {
  adoptTeamAsset,
  fetchProfile,
  listRelatedTeamAssets,
  listTeamAssets,
  listTeamLibraries,
  rescanTeamLibrary,
  teamAssetThumbUrl,
  updateTeamAsset,
  withdrawTeamAsset,
} from '@/api/teamLibraries';
import { TagField, parseTags } from '@/components/assets/TagField';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { CreationAsset } from '@/schema/creationAssets';
import {
  TEAM_ASSET_DRAG_TYPE,
  type TeamAssetAdoptResponse,
  type TeamLibraryIndexEntry,
  type TeamLibraryView,
  type TeamRelatedEntry,
} from '@/schema/teamLibrary';

export interface TeamLibraryPanelProps {
  projectId: string;
  /** 采用完成后交给调用方：由它决定提示与后续动作。 */
  onAdopted: (result: TeamAssetAdoptResponse, entry: TeamLibraryIndexEntry) => void;
  /** 没有挂载库时的「挂载」出口；不给就不显示按钮。 */
  onOpenSettings?: () => void;
  /** 复刻出口（只在 Studio）：面板先采用成本机副本再回调。不给就不显示复刻与相关配方。 */
  onReproduce?: (asset: CreationAsset) => void;
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

/** 列表第一页的筛选参数：提示词走服务端 kind，其余类型在前端过滤。 */
function firstPageFilters(typeFilter: TypeFilter, search: string) {
  return {
    ...(typeFilter === 'prompt' ? { kind: 'prompt' as const } : {}),
    ...(search ? { q: search } : {}),
  };
}

function formatCost(cost: number): string {
  return `¥${cost.toFixed(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
  onReproduce,
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
  const [displayName, setDisplayName] = useState<string | null>(null);
  // 显示名读失败单独记：面板级 error 会被切库 / 搜索清掉，这条不该跟着消失。
  const [profileError, setProfileError] = useState(false);
  const [related, setRelated] = useState<TeamRelatedEntry[]>([]);
  const [relatedError, setRelatedError] = useState(false);
  const [editing, setEditing] = useState<TeamLibraryIndexEntry | null>(null);
  const [withdrawing, setWithdrawing] = useState<TeamLibraryIndexEntry | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const canReproduce = Boolean(onReproduce);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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

  // 显示名决定哪些卡是「我分享的」：只有作者本人能编辑 / 撤回。
  useEffect(() => {
    let alive = true;
    void fetchProfile()
      .then(profile => {
        if (!alive) return;
        setDisplayName(profile.display_name);
        setProfileError(false);
      })
      .catch(() => {
        if (!alive) return;
        setDisplayName(null);
        setProfileError(true);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setRelated([]);
    setRelatedError(false);
    if (!canReproduce) return;
    let alive = true;
    void listRelatedTeamAssets(projectId)
      .then(list => { if (alive) setRelated(list); })
      .catch(() => { if (alive) setRelatedError(true); });
    return () => { alive = false; };
  }, [canReproduce, projectId]);

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
    let alive = true;
    const token = ++requestId.current;
    setError(null);
    void listTeamAssets(libraryId, firstPageFilters(typeFilter, search))
      .then(page => {
        if (!alive || token !== requestId.current) return;
        setEntries(page.entries);
        setCursor(page.next_cursor);
      })
      .catch(() => {
        if (!alive || token !== requestId.current) return;
        setEntries([]);
        setCursor(null);
        setError('读取失败');
      });
    return () => { alive = false; };
  }, [libraryId, search, typeFilter]);

  const loadMore = useCallback(() => {
    if (!libraryId || !cursor) return;
    const token = requestId.current;
    setBusy(true);
    void listTeamAssets(libraryId, { ...firstPageFilters(typeFilter, search), cursor })
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
        // 刷新期间用户可能切库 / 改搜索 / 换类型：迟到的扫描结果不许覆盖更新的请求。
        const token = ++requestId.current;
        return listTeamAssets(view.library_id, firstPageFilters(typeFilter, search)).then(page => {
          if (token !== requestId.current) return;
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

  // 复刻 = 先采用（任何从库到本机的动作都是采用），再把本机副本交给调用方。
  const reproduce = useCallback(
    (targetLibraryId: string, entry: TeamLibraryIndexEntry) => {
      if (!onReproduce) return;
      setBusy(true);
      setError(null);
      void adoptTeamAsset(targetLibraryId, entry.id, projectId)
        .then(result => { if (mounted.current) onReproduce(result.asset); })
        .catch(caught => setError(errorMessage(caught, '复刻失败')))
        .finally(() => setBusy(false));
    },
    [onReproduce, projectId],
  );

  const replaceEntry = useCallback((updated: TeamLibraryIndexEntry) => {
    setEntries(current => current.map(item => (item.id === updated.id ? updated : item)));
    setRelated(current =>
      current.map(item => (item.entry.id === updated.id ? { ...item, entry: updated } : item)),
    );
  }, []);

  const confirmWithdraw = useCallback(() => {
    const target = withdrawing;
    setWithdrawing(null);
    if (!target || !libraryId) return;
    setBusy(true);
    setError(null);
    void withdrawTeamAsset(libraryId, target.id)
      .then(() => {
        setEntries(current => current.filter(item => item.id !== target.id));
        setRelated(current => current.filter(item => item.entry.id !== target.id));
        // 已翻过页时游标指向删除前的位置：重拉第一页，免得「更多」漏掉或重复一条。
        if (!cursor) return;
        const token = ++requestId.current;
        return listTeamAssets(libraryId, firstPageFilters(typeFilter, search)).then(page => {
          if (token !== requestId.current) return;
          setEntries(page.entries);
          setCursor(page.next_cursor);
        });
      })
      .catch(caught => setError(errorMessage(caught, '撤回失败')))
      .finally(() => setBusy(false));
  }, [cursor, libraryId, search, typeFilter, withdrawing]);

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
        <p className="text-xs text-muted-foreground">这个画布还没有团队库</p>
        {onOpenSettings && <Button size="sm" variant="outline" onClick={onOpenSettings}>挂载</Button>}
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-3 p-3', className)}>
      {(related.length > 0 || relatedError) && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">相关配方</p>
          {relatedError && <p className="text-xs text-muted-foreground">读取失败</p>}
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {related.map(item => (
              <button
                key={`${item.library_id}:${item.entry.id}`}
                type="button"
                disabled={busy}
                onClick={() => reproduce(item.library_id, item.entry)}
                className="w-36 shrink-0 rounded-md border border-border bg-card px-2 py-1.5 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
              >
                <p className="truncate text-xs" title={item.entry.title}>{item.entry.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    item.entry.author,
                    item.entry.model,
                    item.entry.cost_cny != null ? formatCost(item.entry.cost_cny) : null,
                  ].filter(part => part != null).join(' · ')}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {(error || profileError) && (
        <div role="alert" className="space-y-0.5 text-xs text-destructive">
          {error && <p>{error}</p>}
          {profileError && <p>读取显示名失败</p>}
        </div>
      )}

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
          aria-label="刷新"
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
                    owned={displayName !== null && entry.kind !== 'raw' && entry.author === displayName}
                    onAdopt={adopt}
                    onReproduce={
                      onReproduce && library
                        ? item => reproduce(library.library_id, item)
                        : undefined
                    }
                    onEdit={setEditing}
                    onWithdraw={setWithdrawing}
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

      {editing && libraryId && (
        <TeamAssetEditDialog
          key={editing.id}
          entry={editing}
          libraryId={libraryId}
          onClose={() => setEditing(null)}
          onSaved={updated => { replaceEntry(updated); setEditing(null); }}
        />
      )}

      <ConfirmDialog
        open={withdrawing !== null}
        title="撤回团队资产"
        message={withdrawing?.title ?? ''}
        confirmText="撤回"
        variant="destructive"
        onConfirm={confirmWithdraw}
        onCancel={() => setWithdrawing(null)}
      />
    </div>
  );
}

function TeamAssetEditDialog({
  entry,
  libraryId,
  onClose,
  onSaved,
}: {
  entry: TeamLibraryIndexEntry;
  libraryId: string;
  onClose: () => void;
  onSaved: (entry: TeamLibraryIndexEntry) => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [tags, setTags] = useState(entry.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    void updateTeamAsset(libraryId, entry.id, { title: trimmed, tags: parseTags(tags) })
      .then(onSaved)
      .catch(caught => {
        setError(errorMessage(caught, '保存失败'));
        setSaving(false);
      });
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !saving) onClose(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>编辑团队资产</DialogTitle></DialogHeader>
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">标题</span>
          <Input value={title} onChange={event => setTitle(event.target.value)} />
        </label>
        <TagField value={tags} onChange={setTags} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>取消</Button>
          <Button size="sm" disabled={saving || !title.trim()} onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamAssetCard({
  entry,
  libraryId,
  busy,
  owned,
  onAdopt,
  onReproduce,
  onEdit,
  onWithdraw,
}: {
  entry: TeamLibraryIndexEntry;
  libraryId: string;
  busy: boolean;
  /** 当前显示名分享的资产：可编辑 / 撤回。 */
  owned: boolean;
  onAdopt: (entry: TeamLibraryIndexEntry) => void;
  onReproduce?: (entry: TeamLibraryIndexEntry) => void;
  onEdit: (entry: TeamLibraryIndexEntry) => void;
  onWithdraw: (entry: TeamLibraryIndexEntry) => void;
}) {
  const [broken, setBroken] = useState(false);
  const incomplete = entry.status === 'incomplete';
  const showThumb = !broken && (entry.mime_type ?? '').startsWith('image/');
  const reproducible = Boolean(onReproduce) && entry.reproducible && entry.status === 'ready';

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
      {entry.kind === 'generation' && entry.model != null && (
        <p className="truncate text-xs text-muted-foreground" title={entry.model}>{entry.model}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {incomplete ? (
          <span className="text-xs text-muted-foreground">同步中</span>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAdopt(entry)}>
            <Download />采用
          </Button>
        )}
        {reproducible && (
          <CardIconButton label="复刻" disabled={busy} onClick={() => onReproduce?.(entry)}>
            <Copy />
          </CardIconButton>
        )}
        {owned && (
          <>
            <CardIconButton label="编辑" disabled={busy} onClick={() => onEdit(entry)}>
              <Pencil />
            </CardIconButton>
            <CardIconButton label="撤回" disabled={busy} onClick={() => onWithdraw(entry)}>
              <Undo2 />
            </CardIconButton>
          </>
        )}
      </div>
    </div>
  );
}

function CardIconButton({ label, disabled, onClick, children }: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="size-8"
    >
      {children}
    </Button>
  );
}
