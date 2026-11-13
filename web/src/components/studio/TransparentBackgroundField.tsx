import type { JobParams } from '@/schema/jobs';
import type { ImageControlCaps } from '@/lib/imageControlCaps';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';

/** Seedream 5.5 的「背景」：自动 = 不发 background，由提示词决定；透明 = 强制出 RGBA PNG，提示词不提也透明。
 *  只在 caps.transparentBackground 时渲染；字段与尺寸参数同一个 bag，换模型时由 normalizeImageSizeParams 清掉。 */
export function TransparentBackgroundField({ caps, params, onPatch }: {
  caps: ImageControlCaps;
  params: JobParams;
  onPatch: (patch: JobParams) => void;
}) {
  if (!caps.transparentBackground) return null;
  const transparent = params.background === 'transparent';
  return (
    <section className="w-full">
      <div className="py-1 px-1 text-xs text-muted-foreground">背景</div>
      <Segmented aria-label="选择背景" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
        <SegmentedItem value="auto" selected={!transparent} onSelect={() => onPatch({ background: undefined })}>
          自动
        </SegmentedItem>
        <SegmentedItem value="transparent" selected={transparent} onSelect={() => onPatch({ background: 'transparent' })}>
          透明
        </SegmentedItem>
      </Segmented>
    </section>
  );
}
