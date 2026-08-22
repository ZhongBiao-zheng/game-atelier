import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, Upload, X } from 'lucide-react';

import { createCharacterDerivative } from '@/api/characters';
import { fetchProjectGallery, type ProjectGalleryMedia } from '@/api/gallery';
import { uploadReferenceImage } from '@/api/studio';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { CharacterEntry } from '@/schema/jobs';

interface LocalSource {
  file: File;
  preview: string;
}

const SUPPLEMENTAL_SOURCE_LIMIT = 40;

export function CreateDerivativeDialog({
  source,
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  source: CharacterEntry | null;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (entry: CharacterEntry) => void;
}) {
  const nameId = useId();
  const fileId = useId();
  const [name, setName] = useState('');
  const [gallery, setGallery] = useState<ProjectGalleryMedia[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [localSources, setLocalSources] = useState<LocalSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewUrls = useRef<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSelectedPaths([]);
    previewUrls.current.forEach(url => URL.revokeObjectURL(url));
    previewUrls.current = [];
    setLocalSources([]);
    setError(null);
    setLoading(true);
    void fetchProjectGallery(projectId, 'all', null, 40)
      .then(page => setGallery(page.items.filter(item => item.media_type === 'image')))
      .catch(reason => setError((reason as Error).message))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  useEffect(() => () => {
    previewUrls.current.forEach(url => URL.revokeObjectURL(url));
  }, []);

  const selected = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  function addLocalSources(files: FileList | null) {
    if (!files?.length) return;
    const remaining = SUPPLEMENTAL_SOURCE_LIMIT - selectedPaths.length - localSources.length;
    if (remaining <= 0) {
      setError(`补充来源最多 ${SUPPLEMENTAL_SOURCE_LIMIT} 张。`);
      return;
    }
    const candidates = Array.from(files);
    const additions = candidates.slice(0, remaining).map(file => ({
      file,
      preview: URL.createObjectURL(file),
    }));
    setError(candidates.length > remaining ? `补充来源最多 ${SUPPLEMENTAL_SOURCE_LIMIT} 张。` : null);
    previewUrls.current.push(...additions.map(item => item.preview));
    setLocalSources(current => [
      ...current,
      ...additions,
    ]);
  }

  function removeLocalSource(preview: string) {
    URL.revokeObjectURL(preview);
    previewUrls.current = previewUrls.current.filter(url => url !== preview);
    setLocalSources(current => current.filter(item => item.preview !== preview));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!source || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await Promise.all(localSources.map(item => uploadReferenceImage(item.file)));
      const entry = await createCharacterDerivative(
        source.id,
        name.trim(),
        [...selectedPaths, ...uploaded],
      );
      onCreated(entry);
      onOpenChange(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => !busy && onOpenChange(value)}>
      <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
        <form onSubmit={event => { void submit(event); }} className="min-w-0 space-y-5">
          <DialogHeader>
            <DialogTitle>创建角色衍生</DialogTitle>
            <DialogDescription>
              基于「{source?.name ?? ''}」和选中的参考图建立一个平级角色。来源图片会复制冻结，之后可独立制作、移动或删除。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor={nameId}>衍生名称</Label>
            <Input
              id={nameId}
              autoFocus
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={source ? `例如：${source.name}·夏日` : '输入名称'}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">当前角色已有的定稿图会自动作为来源，无需重复选择。</p>
          </div>

          <section className="space-y-3" aria-labelledby={`${nameId}-sources`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 id={`${nameId}-sources`} className="text-sm font-medium text-foreground">补充来源素材</h3>
                <p className="mt-1 text-xs text-muted-foreground">可选项目作品，也可上传本地图片。</p>
              </div>
              <Button type="button" variant="outline" size="sm" asChild>
                <label htmlFor={fileId}>
                  <Upload aria-hidden />
                  上传图片
                </label>
              </Button>
              <input
                id={fileId}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={event => addLocalSources(event.target.files)}
              />
            </div>

            {loading && <p className="text-sm text-muted-foreground">正在读取项目作品…</p>}
            {!loading && gallery.length === 0 && localSources.length === 0 && (
              <div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed border-border px-4 text-sm text-muted-foreground">
                <ImagePlus className="size-5 shrink-0" aria-hidden />
                暂无可选作品；仍可只用当前角色定稿，或上传本地图片。
              </div>
            )}
            {(gallery.length > 0 || localSources.length > 0) && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {gallery.map(item => {
                  const isSelected = selected.has(item.path);
                  return (
                    <button
                      key={item.path}
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`${isSelected ? '取消选择' : '选择'} ${item.title} ${item.detail}`}
                      onClick={() => setSelectedPaths(current => {
                        if (current.includes(item.path)) {
                          setError(null);
                          return current.filter(path => path !== item.path);
                        }
                        if (current.length + localSources.length >= SUPPLEMENTAL_SOURCE_LIMIT) {
                          setError(`补充来源最多 ${SUPPLEMENTAL_SOURCE_LIMIT} 张。`);
                          return current;
                        }
                        setError(null);
                        return [...current, item.path];
                      })}
                      className={cn(
                        'relative aspect-square min-w-0 overflow-hidden rounded-md border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        isSelected ? 'border-primary ring-1 ring-primary' : 'border-border',
                      )}
                    >
                      <img
                        src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
                        alt=""
                        className="size-full object-cover"
                      />
                      {isSelected && (
                        <span className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-3.5" aria-hidden />
                        </span>
                      )}
                    </button>
                  );
                })}
                {localSources.map(item => (
                  <div key={item.preview} className="relative aspect-square min-w-0 overflow-hidden rounded-md border border-primary bg-muted ring-1 ring-primary">
                    <img src={item.preview} alt={item.file.name} className="size-full object-cover" />
                    <button
                      type="button"
                      aria-label={`移除本地来源 ${item.file.name}`}
                      onClick={() => removeLocalSource(item.preview)}
                      className="absolute right-1 top-1 grid size-7 place-items-center rounded-full border border-border bg-scrim text-foreground hover:bg-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                    <span className="absolute bottom-0 inset-x-0 truncate bg-background/80 px-1.5 py-1 text-xs text-foreground">
                      {item.file.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button type="submit" disabled={!source || !name.trim() || busy}>
              {busy ? '创建中…' : '创建衍生'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
