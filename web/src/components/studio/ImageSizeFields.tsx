import { Scan, SlidersHorizontal } from 'lucide-react';
import type { JobParams } from '@/schema/jobs';
import type { ImageControlCaps } from '@/lib/imageControlCaps';
import { imageSizeError, imageSizeMode } from '@/lib/imageSizeMode';
import { normalizeImagePixelSize, studioSizeFor, type Resolution } from '@/lib/studioSize';
import { RatioIcon } from './RatioIcon';

export function ImageSizeFields({ caps, model, baseUrl, params, onPatch }: {
  caps: ImageControlCaps;
  model: string;
  baseUrl?: string | null;
  params: JobParams;
  onPatch: (patch: JobParams) => void;
}) {
  const mode = imageSizeMode(params);
  const ratio = params.ratio ?? caps.ratios[0];
  const resolution = (params.resolution ?? caps.resolutions[0] ?? '2K') as Resolution;
  const providerResolution = caps.sizeKind === 'ratio' && caps.showResolution;
  const selectedResolution = providerResolution ? params.resolution ?? 'default' : resolution;
  const size = mode === 'custom' ? params.size ?? params.custom_size ?? ''
    : params.size && /^\d+x\d+$/.test(params.size) ? params.size : studioSizeFor(ratio, resolution, model);
  const [width = '', height = ''] = size.split('x');
  const error = imageSizeError(params, model);
  const options = [...(caps.showAutoSize ? ['auto'] : []), ...caps.ratios, ...(caps.showCustomSize ? ['custom'] : [])];

  function select(value: string) {
    if (value === 'auto') onPatch({ size_mode: 'auto', size: 'auto' });
    else if (value === 'custom') {
      const next = params.custom_size ?? normalizeImagePixelSize(studioSizeFor(ratio, resolution, model), model, baseUrl);
      onPatch({ size_mode: 'custom', size: next, custom_size: next });
    } else onPatch({ size_mode: 'ratio', ratio: value, size: undefined });
  }

  function change(w: string, h: string) {
    const next = `${w}x${h}`;
    if (next === size) return;
    onPatch({ size_mode: 'custom', size: next, custom_size: next });
  }

  function commit() {
    if (mode !== 'custom' || error) return;
    const normalized = normalizeImagePixelSize(size, model, baseUrl);
    if (normalized !== size) onPatch({ size: normalized, custom_size: normalized });
  }

  return (
    <>
      {options.length > 0 && <section>
        <div className="mb-1 px-1 text-xs text-muted-foreground">尺寸</div>
        <div role="listbox" aria-label="选择图片尺寸" className="grid grid-cols-4 gap-y-1 rounded-lg bg-popover p-1">
          {options.map(value => (
            <button key={value} type="button" role="option"
              aria-selected={value === 'auto' || value === 'custom' ? mode === value : mode === 'ratio' && ratio === value}
              onClick={() => select(value)}
              className="flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md text-xs transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {value === 'auto' ? <Scan className="size-4" aria-hidden="true" /> : value === 'custom'
                ? <SlidersHorizontal className="size-4" aria-hidden="true" /> : <RatioIcon ratio={value} box={16} />}
              {value === 'auto' ? 'AUTO' : value === 'custom' ? '自定义' : value}
            </button>
          ))}
        </div>
      </section>}
      {caps.showResolution && mode === 'ratio' && (
        <section>
          <div className="mb-1 px-1 text-xs text-muted-foreground">分辨率</div>
          <div role="listbox" aria-label="选择图片分辨率" className="flex rounded-lg bg-popover p-1">
            {[...(providerResolution ? ['default'] : []), ...caps.resolutions].map(value => <button key={value} type="button" role="option"
              aria-selected={selectedResolution === value}
              onClick={() => onPatch({ resolution: value === 'default' ? undefined : value, size: undefined })}
              className="h-8 flex-1 rounded-md text-xs transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60">{value === 'default' ? '默认' : value}</button>)}
          </div>
        </section>
      )}
      {caps.showCustomSize && mode !== 'auto' && (
        <section>
          <div className="mb-1 px-1 text-xs text-muted-foreground">自定义尺寸</div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg bg-popover p-2"
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) commit(); }}>
            <label className="min-w-0 text-xs text-muted-foreground">宽
              <input type="number" aria-label="输出宽度" min={1} max={100000} step={1} value={width}
                aria-invalid={Boolean(error)} onChange={event => change(event.target.value, height)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" />
            </label>
            <span className="pt-5 text-xs text-muted-foreground">×</span>
            <label className="min-w-0 text-xs text-muted-foreground">高
              <input type="number" aria-label="输出高度" min={1} max={100000} step={1} value={height}
                aria-invalid={Boolean(error)} onChange={event => change(width, event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring" />
            </label>
          </div>
          {error && <p role="alert" className="mt-1 px-1 text-xs text-destructive">{error}</p>}
        </section>
      )}
    </>
  );
}
