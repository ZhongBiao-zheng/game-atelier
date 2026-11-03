import { useRef, useState } from 'react';
import { ImagePlus, Plus, RefreshCw, X } from 'lucide-react';
import { deletePromptPreview, promptPreviewUrl, reorderPromptPreviews, uploadPromptPreviews } from '@/api/creationAssets';
import { Button } from '@/components/ui/button';
import { FileInput } from '@/components/ui/file-input';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { renderCreationPrompt, type CreationAsset, type CreationAssetStaleness } from '@/schema/creationAssets';
import { PromptPreview, StalenessBadge, TagList } from './CreationAssetCards';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function PromptAssetDetail({ asset, busy, staleness, onUpdated, onUse, onEdit, onReadopt }: {
  asset: CreationAsset;
  busy: boolean;
  staleness?: CreationAssetStaleness;
  onUpdated: (asset: CreationAsset) => void;
  onUse: () => void;
  onEdit: () => void;
  onReadopt?: () => void;
}) {
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  if (asset.content.kind !== 'prompt') return null;
  const previews = asset.content.preview_images ?? [];
  const selected = previews.find(p => p.file === selectedFile) ?? previews[0];
  const disabled = busy || saving;
  const mutate = async (action: () => Promise<CreationAsset>, selectNew = false) => {
    if (disabled) return;
    setSaving(true); setError(undefined);
    try {
      const updated = await action();
      if (selectNew && updated.content.kind === 'prompt') {
        setSelectedFile(updated.content.preview_images?.find(p => !previews.some(old => old.file === p.file))?.file ?? selected?.file);
      }
      onUpdated(updated);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存效果图失败'); }
    finally { setSaving(false); }
  };
  const upload = (files: File[], replacement?: string) => {
    if (!files.length) return;
    if (files.some(file => !ACCEPT.split(',').includes(file.type) || file.size > 20 * 1024 * 1024)) {
      setError('请选择 20MB 以内的 PNG、JPEG、WebP 或 GIF'); return;
    }
    void mutate(() => uploadPromptPreviews(asset.asset_id, files, replacement), true);
  };
  return <>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <FileInput ref={addInput} aria-label="添加效果图文件" className="hidden" accept={ACCEPT} multiple disabled={disabled}
        onChange={event => { upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <FileInput ref={replaceInput} aria-label="更换效果图文件" className="hidden" accept={ACCEPT} disabled={disabled}
        onChange={event => { upload(Array.from(event.target.files ?? []), selected?.file); event.target.value = ''; }} />
      {selected ? <div className="space-y-2">
        <div className="relative">
          <img src={promptPreviewUrl(asset.asset_id, selected.file)} alt={`${asset.title}效果图`}
            className="max-h-120 w-full rounded-lg border border-border object-contain" />
          <div className="absolute inset-x-2 bottom-2 flex justify-end gap-2">
            {selected.file !== previews[0]?.file && <Button size="sm" variant="outline" className="h-7 rounded-full bg-glass text-xs" disabled={disabled}
              onClick={() => void mutate(() => reorderPromptPreviews(asset.asset_id, [selected.file, ...previews.filter(p => p.file !== selected.file).map(p => p.file)]))}>设为封面</Button>}
            <Button size="sm" variant="outline" className="h-7 rounded-full bg-glass text-xs" disabled={disabled} onClick={() => replaceInput.current?.click()}>更换</Button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {previews.map((preview, index) => <div key={preview.file} className="group relative">
            <Button variant="ghost" aria-label={`查看效果图 ${index + 1}`} aria-pressed={preview.file === selected.file}
              className={cn('block aspect-square h-auto w-full overflow-hidden rounded-md border-0 p-0', preview.file === selected.file && 'ring-2 ring-primary')}
              onClick={() => setSelectedFile(preview.file)}>
              <img src={promptPreviewUrl(asset.asset_id, preview.file, 128)} alt="" className="h-full w-full object-cover" />
            </Button>
            <Hint label="删除效果图"><Button variant="secondary" size="icon" aria-label={`删除效果图 ${index + 1}`} disabled={disabled}
              className="absolute right-0.5 top-0.5 size-6 rounded-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => void mutate(() => deletePromptPreview(asset.asset_id, preview.file))}><X /></Button></Hint>
          </div>)}
          {previews.length < 8 && <Button variant="ghost" aria-label="添加效果图" disabled={disabled}
            className="aspect-square h-auto rounded-md border border-dashed border-input text-muted-foreground" onClick={() => addInput.current?.click()}><Plus /></Button>}
        </div>
      </div> : <Button variant="ghost" disabled={disabled} className="flex aspect-[4/3] h-auto w-full flex-col gap-2 rounded-lg border border-dashed border-input text-muted-foreground"
        onClick={() => addInput.current?.click()} onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); upload(Array.from(event.dataTransfer.files)); }}><ImagePlus />添加效果图</Button>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <section className="space-y-2">
        <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">提示词</span>
          <Button size="sm" variant="ghost" onClick={() => {
            if (asset.content.kind !== 'prompt') return;
            void navigator.clipboard.writeText(renderCreationPrompt(asset.content.segments)).then(() => setCopied(true)).catch(() => setError('复制失败'));
          }}>{copied ? '已复制' : '复制'}</Button></div>
        <div className="rounded-lg bg-card p-3"><PromptPreview segments={asset.content.segments} clamp={false} /></div>
        <TagList tags={asset.tags} />
      </section>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {selected?.source_model && <><dt>效果图模型</dt><dd>{selected.source_model}</dd></>}
        <dt>使用次数</dt><dd className="tabular-nums">{asset.use_count ?? 0}</dd>
        <dt>最近使用</dt><dd className="tabular-nums">{asset.last_used_at ? new Date(asset.last_used_at).toLocaleDateString('zh-CN') : '未使用'}</dd>
      </dl>
      <StalenessBadge staleness={staleness} />
    </div>
    <div className="flex shrink-0 flex-wrap gap-2 border-t border-border p-3">
      <Button className="flex-1" disabled={disabled} onClick={onUse}>使用</Button>
      <Button variant="outline" disabled={disabled} onClick={onEdit}>编辑</Button>
      {staleness === 'stale' && onReadopt && <Button variant="outline" disabled={disabled} onClick={onReadopt}><RefreshCw />重新采用</Button>}
    </div>
  </>;
}
