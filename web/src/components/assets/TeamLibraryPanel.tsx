import { formatGenerationCost } from '@/lib/generationCost';
import {
  Copy,
  Download,
  ChevronDown,
  Folder,
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
  teamAssetContentUrl,
  teamAssetThumbUrl,
  updateTeamAsset,
  withdrawTeamAsset,
} from '@/api/teamLibraries';
import { CategoryField, TagField, parseTags } from '@/components/assets/TagField';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MountTeamLibraryDialog } from '@/components/team/MountTeamLibraryDialog';
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
import { DEFAULT_CANVAS_CATEGORIES } from '@/schema/canvas';
import type { CreationAsset } from '@/schema/creationAssets';
import {
  TEAM_ASSET_DRAG_TYPE,
  type TeamAssetAdoptResponse,
  type TeamLibraryIndexEntry,
  type TeamLibraryView,
  type TeamRelatedEntry,
} from '@/schema/teamLibrary';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AssetFilterPill } from './AssetFilterPill';
import { AssetMasonry, mediaRatio, useMediaSizes, type MediaSize } from './AssetMasonry';
import { AssetMediaTile } from './AssetMediaTile';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Hint } from '@/components/ui/tooltip';
import { Label } from '@/components/ui/label';

export interface TeamLibraryPanelProps {
  projectId: string;
  /** 采用完成后交给调用方：由它决定提示与后续动作。 */
  onAdopted: (result: TeamAssetAdoptResponse, entry: TeamLibraryIndexEntry) => void;
  /** 复刻出口（Studio 与画布都传）：面板先采用成本机副本再回调。不给就不显示复刻与相关配方。 */
  onReproduce?: (asset: CreationAsset) => void;
  /** 有值时顶部「相关配方」改为参考内容命中这份 sha256 的配方。 */
  relatedSha256?: string | null;
  /** 初始选中的库（「看看」定位到提醒里的库）；不在本画布的挂载列表里就忽略。 */
  initialTeamLibraryId?: string | null;
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

/** 列表第一页的筛选参数：提示词走服务端 kind，其余类型在前端过滤。 */
function firstPageFilters(typeFilter: TypeFilter, search: string) {
  return {
    ...(typeFilter === 'prompt' ? { kind: 'prompt' as const } : {}),
    ...(search ? { q: search } : {}),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function TeamLibraryPanel({
  projectId,
  onAdopted,
  onReproduce,
  relatedSha256,
  initialTeamLibraryId,
  className,
}: TeamLibraryPanelProps) {
  const [libraries, setLibraries] = useState<TeamLibraryView[]>([]);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [node, setNode] = useState<TreeNode | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [viewing, setViewing] = useState<TeamLibraryIndexEntry | null>(null);
  const { sizes, measure } = useMediaSizes();
  const mediaKey = (entry: TeamLibraryIndexEntry) => `${libraryId}:${entry.id}:${entry.updated_at}`;
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
  const [mountOpen, setMountOpen] = useState(false);
  const [mountsVersion, setMountsVersion] = useState(0);
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
        // 已选的库还在就留着；否则先落到调用方指定的库，再退回第一个。
        setLibraryId(current =>
          [current, initialTeamLibraryId].find(id => id && list.some(item => item.library_id === id))
            ?? list[0]?.library_id
            ?? null,
        );
      })
      .catch(() => { if (alive) setLibraries([]); });
    return () => { alive = false; };
  }, [projectId, initialTeamLibraryId, mountsVersion]);

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
    void (relatedSha256 ? listRelatedTeamAssets(projectId, relatedSha256) : listRelatedTeamAssets(projectId))
      .then(list => { if (alive) setRelated(list); })
      .catch(() => { if (alive) setRelatedError(true); });
    return () => { alive = false; };
  }, [canReproduce, projectId, relatedSha256]);

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
        <Button size="sm" variant="outline" onClick={() => setMountOpen(true)}>挂载</Button>
        <MountTeamLibraryDialog open={mountOpen} currentProjectId={projectId} onClose={() => setMountOpen(false)}
          onMounted={() => setMountsVersion(version => version + 1)} />
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
              <Button variant="ghost"
                key={`${item.library_id}:${item.entry.id}`}
                type="button"
                disabled={busy}
                onClick={() => reproduce(item.library_id, item.entry)}
                className="block h-auto w-36 shrink-0 rounded-md border border-border bg-card px-2 py-1.5 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
              >
                <Hint label={item.entry.title}><p className="truncate text-xs">{item.entry.title}</p></Hint>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    item.entry.author,
                    item.entry.model,
                    item.entry.cost_cny != null ? formatGenerationCost(item.entry.cost_cny) : null,
                  ].filter(part => part != null).join(' · ')}
                </p>
              </Button>
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

      <Popover open={selectorOpen} onOpenChange={setSelectorOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" aria-label="团队库" className="h-10 w-full justify-start bg-card font-normal">
            <Folder /><span className="min-w-0 flex-1 truncate text-left">{library?.name}</span>
            <span className="max-w-24 truncate text-xs text-muted-foreground">{node?.name ?? '全部目录'}</span><ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-1">
          {libraries.map(item => <Button key={item.library_id} variant="ghost" className="w-full justify-start"
            aria-pressed={libraryId === item.library_id} onClick={() => { setNode(null); setLibraryId(item.library_id); setSelectorOpen(false); }}>
            <Folder />{item.name}
          </Button>)}
          <div className="max-h-64 space-y-1 overflow-y-auto border-t border-border pt-1" role="group" aria-label="目录">
            <Button variant="ghost" size="sm" className="w-full justify-start" aria-pressed={!node}
              onClick={() => { setNode(null); setSelectorOpen(false); }}>全部目录</Button>
            {tree.map(item => <Button key={`${item.group}:${item.name}`} variant="ghost" size="sm"
              className="w-full justify-start truncate pl-6" aria-pressed={node ? sameNode(node, item) : false}
              onClick={() => { setNode(item); setSelectorOpen(false); }}>{item.name}</Button>)}
          </div>
        </PopoverContent>
      </Popover>
      <div className="flex items-center gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label="搜索团队库" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索" />
        </InputGroup>
        <Button size="icon" variant="outline" aria-label="刷新" disabled={busy} onClick={rescan}><RefreshCw /></Button>
      </div>
      <div role="group" aria-label="类型" className="flex flex-wrap gap-2">
        {TYPE_FILTERS.filter(item => item.value !== 'audio' || entries.some(entry => entry.mime_type?.startsWith('audio/')) || typeFilter === 'audio')
          .map(item => <AssetFilterPill key={item.value} selected={typeFilter === item.value}
            onClick={() => { setNode(null); setTypeFilter(item.value); }}>{item.label}</AssetFilterPill>)}
      </div>
      {library && !library.reachable ? (
        <p className="py-8 text-center text-sm text-muted-foreground">目录不可达</p>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">库里还没有内容</p> : (
            <AssetMasonry items={visible} itemKey={mediaKey} ratio={entry => mediaRatio(sizes[mediaKey(entry)])}>
              {entry => <TeamAssetCard entry={entry} libraryId={library?.library_id ?? ''} busy={busy}
                size={sizes[mediaKey(entry)]} onMeasure={size => measure(mediaKey(entry), size)}
                owned={displayName !== null && entry.kind !== 'raw' && entry.author === displayName}
                onAdopt={adopt} onView={setViewing}
                onReproduce={onReproduce && library ? item => reproduce(library.library_id, item) : undefined}
                onEdit={setEditing} onWithdraw={setWithdrawing} />}
            </AssetMasonry>
          )}
          {cursor && <div className="pt-3 text-center"><Button size="sm" variant="outline" disabled={busy} onClick={loadMore}>更多</Button></div>}
        </div>
      )}
      {viewing && libraryId && <Dialog open onOpenChange={open => { if (!open) setViewing(null); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{viewing.title}</DialogTitle></DialogHeader>
          {viewing.kind === 'prompt' ? <p className="whitespace-pre-wrap rounded-lg bg-card p-3 text-sm">{viewing.prompt_text}</p>
            : viewing.mime_type?.startsWith('image/') ? <img src={teamAssetContentUrl(libraryId, viewing.id)} alt={viewing.title} className="max-h-120 w-full rounded-lg object-contain" />
              : viewing.mime_type?.startsWith('video/') ? <video src={teamAssetContentUrl(libraryId, viewing.id)} controls className="max-h-120 w-full rounded-lg" />
                : <audio src={teamAssetContentUrl(libraryId, viewing.id)} controls className="w-full" />}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {viewing.author && <><dt>作者</dt><dd>{viewing.author}</dd></>}
            {viewing.model && <><dt>模型</dt><dd>{viewing.model}</dd></>}
            {viewing.cost_cny != null && <><dt>花费</dt><dd>{formatGenerationCost(viewing.cost_cny)}</dd></>}
          </dl>
          <DialogFooter><Button disabled={busy} onClick={() => adopt(viewing)}>采用</Button></DialogFooter>
        </DialogContent>
      </Dialog>}

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
  const [category, setCategory] = useState(entry.category ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    void updateTeamAsset(libraryId, entry.id, { title: trimmed, tags: parseTags(tags), category: category.trim() || null })
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
        <Label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">标题</span>
          <Input value={title} onChange={event => setTitle(event.target.value)} />
        </Label>
        {entry.kind !== 'prompt' && <CategoryField value={category} onChange={setCategory} disabled={saving}
          options={[...new Set([...(entry.category ? [entry.category] : []), ...DEFAULT_CANVAS_CATEGORIES])]} />}
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

function TeamAssetCard({ entry, libraryId, busy, owned, size, onMeasure, onAdopt, onView, onReproduce, onEdit, onWithdraw }: {
  entry: TeamLibraryIndexEntry;
  libraryId: string;
  busy: boolean;
  owned: boolean;
  size?: MediaSize;
  onMeasure: (size: MediaSize) => void;
  onAdopt: (entry: TeamLibraryIndexEntry) => void;
  onView: (entry: TeamLibraryIndexEntry) => void;
  onReproduce?: (entry: TeamLibraryIndexEntry) => void;
  onEdit: (entry: TeamLibraryIndexEntry) => void;
  onWithdraw: (entry: TeamLibraryIndexEntry) => void;
}) {
  const incomplete = entry.status === 'incomplete';
  const mime = entry.mime_type ?? '';
  const reproducible = Boolean(onReproduce) && entry.reproducible && !incomplete;
  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(TEAM_ASSET_DRAG_TYPE, JSON.stringify({ library_id: libraryId, entry_id: entry.id }));
    event.dataTransfer.effectAllowed = 'copy';
  };
  return <div draggable={!incomplete} onDragStart={onDragStart} className={cn('group min-w-0', incomplete && 'opacity-50')}>
    <div className="relative">
      <Button variant="ghost" aria-label={`查看 ${entry.title}`} disabled={incomplete} onClick={() => onView(entry)} className="block h-auto w-full p-0 text-left font-normal">
        {entry.kind === 'prompt' ? <span className="block rounded-md border border-border bg-card p-3">
          <span className="mb-2 block truncate text-sm font-medium">{entry.title}</span>
          <span className="line-clamp-2 whitespace-normal text-xs text-muted-foreground">{entry.prompt_text}</span>
        </span> : <AssetMediaTile src={mime.startsWith('image/') ? teamAssetThumbUrl(libraryId, entry.id, 256) : teamAssetContentUrl(libraryId, entry.id)}
          mimeType={incomplete ? '' : mime} alt={entry.title} size={size} onMeasure={onMeasure} />}
      </Button>
      <div className="pointer-events-none absolute inset-x-1 bottom-1 flex flex-wrap items-center justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-glass p-0.5 backdrop-blur-glass">
          {reproducible && <CardIconButton label="复刻" disabled={busy} onClick={() => onReproduce?.(entry)}><Copy /></CardIconButton>}
          {owned && <>
            <CardIconButton label="编辑" disabled={busy} onClick={() => onEdit(entry)}><Pencil /></CardIconButton>
            <CardIconButton label="撤回" disabled={busy} onClick={() => onWithdraw(entry)}><Undo2 /></CardIconButton>
          </>}
          {!incomplete && <Button size="sm" className="h-7 rounded-full px-2 text-xs" disabled={busy} onClick={() => onAdopt(entry)}><Download />采用</Button>}
        </div>
      </div>
    </div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {entry.author && <Hint label={entry.author}><span className="grid size-4 shrink-0 place-items-center rounded-full bg-secondary">{Array.from(entry.author)[0]}</span></Hint>}
      {entry.kind !== 'prompt' && <Hint label={entry.title}><span className="truncate">{entry.title}</span></Hint>}
      {incomplete && <span className="shrink-0">同步中</span>}
    </div>
  </div>;
}

function CardIconButton({ label, disabled, onClick, children }: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint label={label}><Button
      size="icon"
      variant="ghost"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="size-8"
    >
      {children}
    </Button></Hint>
  );
}
