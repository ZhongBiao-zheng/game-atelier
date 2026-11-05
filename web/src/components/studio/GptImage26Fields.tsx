import type { JobParams } from '@/schema/jobs';
import {
  COMPLEXITY_LABELS, GIF_FRAME_COUNT, GIF_FRAME_DURATION_MS, type Complexity, type ImageControlCaps,
} from '@/lib/imageControlCaps';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';

/** GPT Image 2.6 专属控件：规划强度与 GIF 输出。两者都只在 caps 声明支持时渲染，
 *  参数直接写进 JobParams（与尺寸参数同一个 bag），由 normalizeImageSizeParams 在换模型时清掉。 */
export function GptImage26Fields({ caps, params, onPatch, hasReferences = false }: {
  caps: ImageControlCaps;
  params: JobParams;
  onPatch: (patch: JobParams) => void;
  /** 带参考图时 GIF 不可用（官方只在 generations 端点支持动图）。 */
  hasReferences?: boolean;
}) {
  const complexity: Complexity = params.complexity ?? 'high';
  const gif = params.output_format === 'gif';
  const frameCount = params.frame_count ?? GIF_FRAME_COUNT.default;
  const frameDuration = params.frame_duration_ms ?? GIF_FRAME_DURATION_MS.default;

  function clamp(value: string, range: { min: number; max: number; default: number }): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return range.default;
    return Math.min(range.max, Math.max(range.min, parsed));
  }

  return <>
    {caps.complexities && (
      <section className="w-full">
        <div className="py-1 px-1 text-xs text-muted-foreground">规划</div>
        <Segmented aria-label="选择规划强度" className="grid h-9 grid-cols-3 rounded-lg bg-popover p-0.5">
          {caps.complexities.map(item => (
            <SegmentedItem key={item} value={item} selected={complexity === item}
              onSelect={() => onPatch({ complexity: item })}>
              {COMPLEXITY_LABELS[item]}
            </SegmentedItem>
          ))}
        </Segmented>
      </section>
    )}
    {caps.gifOutput && (
      <section className="w-full space-y-2">
        <div className="py-1 px-1 text-xs text-muted-foreground">输出</div>
        <Segmented aria-label="选择输出格式" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
          <SegmentedItem value="image" selected={!gif}
            onSelect={() => onPatch({ output_format: undefined, frame_count: undefined, frame_duration_ms: undefined })}>
            图片
          </SegmentedItem>
          <SegmentedItem value="gif" selected={gif} disabled={hasReferences}
            onSelect={() => onPatch({ output_format: 'gif', frame_count: frameCount, frame_duration_ms: frameDuration })}>
            GIF
          </SegmentedItem>
        </Segmented>
        {gif && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="gif-frame-count" className="px-1 text-xs text-muted-foreground">帧数</Label>
              <Input id="gif-frame-count" type="number" inputMode="numeric"
                min={GIF_FRAME_COUNT.min} max={GIF_FRAME_COUNT.max} value={frameCount}
                onChange={event => onPatch({ frame_count: clamp(event.target.value, GIF_FRAME_COUNT) })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gif-frame-duration" className="px-1 text-xs text-muted-foreground">帧间隔 ms</Label>
              <Input id="gif-frame-duration" type="number" inputMode="numeric" step={10}
                min={GIF_FRAME_DURATION_MS.min} max={GIF_FRAME_DURATION_MS.max} value={frameDuration}
                onChange={event => onPatch({ frame_duration_ms: clamp(event.target.value, GIF_FRAME_DURATION_MS) })} />
            </div>
          </div>
        )}
      </section>
    )}
  </>;
}

/** 历史卡片 / 画布摘要用的一句话：`GIF 9 帧 · 200ms`。 */
export function gifSummary(params: Pick<JobParams, 'output_format' | 'frame_count' | 'frame_duration_ms'>): string | null {
  if (params.output_format !== 'gif') return null;
  return `GIF ${params.frame_count ?? GIF_FRAME_COUNT.default} 帧 · ${params.frame_duration_ms ?? GIF_FRAME_DURATION_MS.default}ms`;
}
