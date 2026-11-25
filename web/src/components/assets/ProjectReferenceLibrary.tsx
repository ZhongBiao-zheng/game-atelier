import { useCallback, useEffect, useRef, useState } from 'react';
import { AddIcon, AiIcon, MoreIcon, UploadIcon } from '@/components/ui/icons';
import { classifyCreationAssets, listCreationAssets, updateCreationAssetCategory, uploadMediaCreationAsset } from '@/api/creationAssets';
import { listCanvasProjects } from '@/api/canvas';
import { MediaPreview } from './CreationAssetCards';
import { rememberedModel } from '@/components/agent/useWorkspaceAgent';
import { Button } from '@/components/ui/button';
import { assetMediaContent, CREATION_ASSET_DRAG_TYPE, type CreationAsset, type CategorySuggestion } from '@/schema/creationAssets';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { errorText } from '@/lib/errorText';
import { notify } from '@/lib/notify';
import { FileInput } from '@/components/ui/file-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import { Collapse } from '@/components/ui/collapse';
import { useRetained } from '@/components/ui/retained';
import { prefersReducedMotion } from '@/lib/motion';

/** 改类别后卡片落到新分组：目标处描边高亮这么久再淡掉，看得出它去了哪。 */
const LANDED_MS = 1500;

/** Select 不接受空字符串选项值，「无类别」用这个占位。 */
const NO_CATEGORY = '__none__';

interface PendingQueue { ids: string[]; suggestions: Record<string, CategorySuggestion> }

// 待分类队列与已付费拿到的分类建议跟着项目存在本机，关掉面板、刷新页面都不丢。
function pendingKey(projectId: string) { return `atelier.reference-pending.${projectId}`; }

function readPending(projectId: string): PendingQueue {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pendingKey(projectId)) || '{}');
    const row = value && typeof value === 'object' ? value as Partial<PendingQueue> : {};
    return {
      ids: Array.isArray(row.ids) ? row.ids.filter((id): id is string => typeof id === 'string') : [],
      suggestions: row.suggestions && typeof row.suggestions === 'object' ? row.suggestions : {},
    };
  } catch { return { ids: [], suggestions: {} }; }
}

function writePending(projectId: string, queue: PendingQueue) {
  try {
    if (queue.ids.length) localStorage.setItem(pendingKey(projectId), JSON.stringify(queue));
    else localStorage.removeItem(pendingKey(projectId));
  } catch { /* 存不了就只在本次面板里保留 */ }
}

export function ProjectReferenceLibrary({ projectId, refreshKey, visible, busy: parentBusy = false, onUse, onOpen, onAssetsChanged }: {
  projectId: string;
  visible: boolean;
  refreshKey?: number;
  /** 面板正在「使用」：卡片上的使用键跟着禁用。 */
  busy?: boolean;
  onUse: (asset: CreationAsset) => void;
  /** 点卡片进资产详情（与个人资产同一套：悬停「使用」，点卡片看详情）。 */
  onOpen: (asset: CreationAsset) => void;
  onAssetsChanged?: () => Promise<void>;
}) {
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<string[]>(() => readPending(projectId).ids);
  const [suggestions, setSuggestions] = useState<Record<string, CategorySuggestion>>(() => readPending(projectId).suggestions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = useRetained(error);
  const [dragOver, setDragOver] = useState(false);
  const [landed, setLanded] = useState<string | null>(null);
  useEffect(() => {
    if (!landed) return;
    const timer = window.setTimeout(() => setLanded(null), LANDED_MS);
    return () => window.clearTimeout(timer);
  }, [landed]);
  // 落点不在可见区时滚过去（减弱动态效果时直接跳到）。
  const revealLanded = useCallback((element: HTMLElement | null) => {
    element?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const [list, projects] = await Promise.all([
      listCreationAssets({ projectId, scope: 'project' }), listCanvasProjects(true),
    ]);
    if (!active.current) return;
    const media = list.assets.filter(asset => assetMediaContent(asset) !== null);
    setAssets(media);
    setCategories(projects.find(project => project.project_id === projectId)?.categories ?? []);
    // 已定稿或已不在本项目的资产移出队列，存档不无限增长。
    const waiting = new Set(media.filter(asset => !asset.category).map(asset => asset.asset_id));
    setPendingIds(current => current.every(id => waiting.has(id)) ? current : current.filter(id => waiting.has(id)));
  }, [projectId]);
  useEffect(() => { if (visible) void refresh().catch(error => setError((error as Error).message)); }, [refresh, refreshKey, visible]);
  useEffect(() => {
    const kept = new Set(pendingIds);
    writePending(projectId, { ids: pendingIds, suggestions: Object.fromEntries(Object.entries(suggestions).filter(([id]) => kept.has(id))) });
  }, [projectId, pendingIds, suggestions]);
  const pending = assets.filter(asset => pendingIds.includes(asset.asset_id) && !asset.category);
  const classifyModel = rememberedModel();
  const groups = [...new Set([...categories, ...assets.flatMap(asset => asset.category ? [asset.category] : [])])];

  async function changed() {
    await refresh();
    await onAssetsChanged?.();
  }

  async function importFiles(files: File[]) {
    if (busy || !files.length) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) { failures.push(`${file.name}：请选择图片`); continue; }
        try {
          const asset = await uploadMediaCreationAsset({ file, title: file.name.slice(0, 120), tags: [], projectId, allowExisting: true });
          if (!asset.category) setPendingIds(current => [...new Set([...current, asset.asset_id])]);
        } catch (error) { failures.push(`${file.name}：${(error as Error).message}`); }
      }
      await changed();
      if (failures.length) setError(failures.join('；'));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function classify() {
    setBusy(true);
    setError(null);
    try {
      const selection = classifyModel;
      for (let offset = 0; offset < pending.length; offset += 48) {
        const rows = await classifyCreationAssets(projectId, pending.slice(offset, offset + 48).map(asset => asset.asset_id), selection);
        setSuggestions(current => ({ ...current, ...Object.fromEntries(rows.map(row => [row.asset_id, row])) }));
      }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function categorize(asset: CreationAsset, category: string | null) {
    setBusy(true);
    setError(null);
    try { await updateCreationAssetCategory(asset.asset_id, category); await changed(); if (category) setLanded(asset.asset_id); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  /** 取消定稿会让卡片当场离开参考库：不放在类别下拉里防误选，执行后给撤销。 */
  async function unfinalize(asset: CreationAsset) {
    const previous = asset.category;
    await categorize(asset, null);
    if (!previous) return;
    notify.undo('已取消定稿', () => {
      updateCreationAssetCategory(asset.asset_id, previous)
        .then(() => changed())
        .then(() => setLanded(asset.asset_id))
        .catch(caught => notify.error(errorText(caught, '恢复定稿失败')));
    });
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      for (const asset of pending) {
        const category = suggestions[asset.asset_id]?.category;
        if (!category) continue;
        await updateCreationAssetCategory(asset.asset_id, category);
        setPendingIds(current => current.filter(id => id !== asset.asset_id));
      }
    } catch (error) { setError((error as Error).message); }
    finally {
      try { await changed(); } catch (error) { setError((error as Error).message); }
      setBusy(false);
    }
  }

  function card(asset: CreationAsset, waiting = false) {
    const media = assetMediaContent(asset);
    if (!media) return null;
    const suggestion = suggestions[asset.asset_id];
    const value = waiting ? suggestion?.category ?? '' : asset.category ?? '';
    const isLanded = !waiting && landed === asset.asset_id;
    // 已定稿的卡片与个人资产同一套：悬停「使用」、能拖进画布（落点与「使用」一致）、点图进详情。
    return <article key={asset.asset_id} ref={isLanded ? revealLanded : undefined}
      draggable={!waiting}
      onDragStart={waiting ? undefined : event => {
        event.dataTransfer.setData(CREATION_ASSET_DRAG_TYPE, JSON.stringify({ asset_id: asset.asset_id }));
        event.dataTransfer.effectAllowed = 'copy';
      }}
      className={`group relative mb-3 break-inside-avoid overflow-hidden rounded-lg border bg-card p-3 transition-[border-color,box-shadow] duration-300 ${isLanded ? 'content-swap-in border-primary ring-1 ring-primary/60' : 'border-border'}`}>
      <Button variant="ghost" aria-label={asset.title} className="mb-2 block h-auto w-full p-0" onClick={() => onOpen(asset)}>
        <MediaPreview assetId={asset.asset_id} content={media} alt={asset.title} className="max-h-64 w-full rounded-md object-contain" />
      </Button>
      {!waiting && <div className="pointer-events-none absolute right-4 top-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <Button variant="solid" size="sm" className="pointer-events-auto h-7 rounded-full px-2 text-xs" disabled={busy || parentBusy}
          onClick={() => onUse(asset)}><AddIcon />使用</Button>
      </div>}
      <Hint label={asset.title}><p className="truncate text-sm">{asset.title}</p></Hint>
      <div className="mt-2 flex items-center gap-2">
        <Select value={value || NO_CATEGORY} disabled={busy}
          onValueChange={next => {
            const category = next === NO_CATEGORY ? null : next;
            if (waiting) setSuggestions(current => ({ ...current, [asset.asset_id]: { asset_id: asset.asset_id, category, confidence: 1 } }));
            else void categorize(asset, category);
          }}>
          <SelectTrigger size="sm" aria-label={`${asset.title} 的类别`} className="flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            {waiting && <SelectItem value={NO_CATEGORY}>待分类</SelectItem>}
            {[...new Set([...categories, ...(value ? [value] : [])])].map(category => <SelectItem key={category} value={category}>{category}</SelectItem>)}
          </SelectContent>
        </Select>
        {waiting && suggestion && <Hint label="分类置信度"><span className="text-xs tabular-nums text-muted-foreground">{Math.round(suggestion.confidence * 100)}%</span></Hint>}
        {!waiting && <DropdownMenu><DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`${asset.title} 的更多操作`} disabled={busy}><MoreIcon /></Button>
        </DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void unfinalize(asset)}>取消定稿</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>}
      </div>
    </article>;
  }

  // 拖着文件经过时整块描一圈虚线主色框，告诉用户这里能放；离开或放下即撤。
  return <div className={`flex min-h-0 flex-1 flex-col rounded-lg outline-2 -outline-offset-4 transition-[outline-color] duration-150 ${dragOver ? 'outline-dashed outline-primary/60' : 'outline-transparent'}`} onDragOver={event => {
    if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragOver(true); }
  }} onDragLeave={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
  }} onDrop={event => {
    setDragOver(false);
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); event.stopPropagation();
    void importFiles(Array.from(event.dataTransfer.files));
  }}>
    <div className="border-b border-border p-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}><UploadIcon />导入</Button>
      <FileInput ref={input} multiple accept="image/*" aria-label="导入参考图" className="hidden" onChange={event => {
        void importFiles(Array.from(event.target.files ?? [])); event.target.value = '';
      }} />
      <Collapse open={Boolean(error)}><p role="alert" className="mt-2 text-xs text-destructive">{shownError}</p></Collapse>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3" style={{ scrollbarGutter: 'stable' }}>
      {pending.length > 0 && <section aria-label="待分类" className="mb-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm">待分类 · {pending.length}</h3>
          {/* 借用 Agent 面板上次选的对话模型：写出是哪个模型；没选过就不让点，说清去哪选。 */}
          <Hint label={classifyModel ? `用 ${classifyModel.model} 分类，会产生模型费用` : '先在 Agent 面板选择对话模型'}>
            <span><Button variant="ghost" size="sm" disabled={busy || !classifyModel} onClick={() => void classify()}><AiIcon />自动分类</Button></span>
          </Hint>
        </div>
        <div className="columns-[14rem] gap-3">{pending.map(asset => card(asset, true))}</div>
        <Button size="sm" disabled={busy || !pending.some(asset => suggestions[asset.asset_id]?.category)} onClick={() => void confirm()}>全部确认</Button>
      </section>}
      {groups.map(category => {
        const rows = assets.filter(asset => asset.category === category);
        return rows.length ? <section key={category} aria-label={category} className="mb-4">
          <h3 className="mb-2 text-sm">{category} · {rows.length}</h3>
          <div className="columns-[14rem] gap-3">{rows.map(asset => card(asset))}</div>
        </section> : null;
      })}
      {!pending.length && !assets.some(asset => asset.category) && <p className="py-8 text-center text-xs text-muted-foreground">拖入图片，或在画布中定稿</p>}
    </div>
  </div>;
}
