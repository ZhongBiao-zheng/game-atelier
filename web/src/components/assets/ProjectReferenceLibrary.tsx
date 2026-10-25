import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, WandSparkles } from 'lucide-react';
import { classifyCreationAssets, listCreationAssets, updateCreationAssetCategory, uploadMediaCreationAsset } from '@/api/creationAssets';
import { listCanvasProjects } from '@/api/canvas';
import { MediaPreview } from './CreationAssetCards';
import { rememberedModel } from '@/components/canvas/agent/useCanvasAgent';
import { Button } from '@/components/ui/button';
import { assetMediaContent, type CreationAsset, type CategorySuggestion } from '@/schema/creationAssets';

export function ProjectReferenceLibrary({ projectId, refreshKey, visible, onUse, onAssetsChanged }: {
  projectId: string;
  visible: boolean;
  refreshKey?: number;
  onUse: (asset: CreationAsset) => void;
  onAssetsChanged?: () => Promise<void>;
}) {
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, CategorySuggestion>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const [list, projects] = await Promise.all([
      listCreationAssets({ projectId, scope: 'project' }), listCanvasProjects(true),
    ]);
    if (!active.current) return;
    setAssets(list.assets.filter(asset => assetMediaContent(asset) !== null));
    setCategories(projects.find(project => project.project_id === projectId)?.categories ?? []);
  }, [projectId]);
  useEffect(() => { if (visible) void refresh().catch(error => setError((error as Error).message)); }, [refresh, refreshKey, visible]);
  const pending = assets.filter(asset => pendingIds.includes(asset.asset_id) && !asset.category);
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
      const selection = rememberedModel();
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
    try { await updateCreationAssetCategory(asset.asset_id, category); await changed(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
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
    return <article key={asset.asset_id} className="mb-3 break-inside-avoid overflow-hidden rounded-lg border border-border bg-card p-3">
      <MediaPreview assetId={asset.asset_id} content={media} alt={asset.title} className="mb-2 max-h-64 w-full rounded-md object-contain" />
      <p className="truncate text-sm" title={asset.title}>{asset.title}</p>
      <div className="mt-2 flex items-center gap-2">
        <select aria-label={`${asset.title} 的类别`} value={value} disabled={busy}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
          onChange={event => {
            const category = event.target.value || null;
            if (waiting) setSuggestions(current => ({ ...current, [asset.asset_id]: { asset_id: asset.asset_id, category, confidence: 1 } }));
            else void categorize(asset, category);
          }}>
          <option value="">{waiting ? '待分类' : '取消定稿'}</option>
          {[...new Set([...categories, ...(value ? [value] : [])])].map(category => <option key={category} value={category}>{category}</option>)}
        </select>
        {waiting && suggestion && <span className="text-xs tabular-nums text-muted-foreground" title="分类置信度">{Math.round(suggestion.confidence * 100)}%</span>}
      </div>
      {!waiting && <Button variant="ghost" size="sm" className="mt-2 w-full" disabled={busy} onClick={() => onUse(asset)}>放到画布</Button>}
    </article>;
  }

  return <div className="flex min-h-0 flex-1 flex-col" onDragOver={event => {
    if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); }
  }} onDrop={event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); event.stopPropagation();
    void importFiles(Array.from(event.dataTransfer.files));
  }}>
    <div className="border-b border-border p-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}><Upload />导入</Button>
      <input ref={input} type="file" multiple accept="image/*" aria-label="导入参考图" className="hidden" onChange={event => {
        void importFiles(Array.from(event.target.files ?? [])); event.target.value = '';
      }} />
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3" style={{ scrollbarGutter: 'stable' }}>
      {pending.length > 0 && <section aria-label="待分类" className="mb-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm">待分类 · {pending.length}</h3>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void classify()} title="使用 Agent 中选择的对话模型，此操作会产生模型费用"><WandSparkles />自动分类</Button>
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
