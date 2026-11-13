import { useRef, useState, type ReactNode } from 'react';
import { HelpIcon, MuteIcon, VideoIcon, VolumeIcon } from '@/components/ui/icons';
import {
  VIDEO_MODE_LABELS,
  VIDEO_QUALITY_LABELS,
  durationRangeOf,
  ratioLabel,
  type VideoControlCaps,
  type VideoMode,
  type VideoQuality,
} from '@/lib/videoControlCaps';
import { RatioIcon } from './RatioIcon';
import { ToolbarPopover, type ToolbarPopoverMenuProps } from './ToolbarPopover';
import { cn } from '@/lib/utils';
import { SwapIcon } from '@/components/ui/swap-icon';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Slider, SliderMarks } from '@/components/ui/slider';
import { NumberInput } from '@/components/ui/number-input';

interface Props extends ToolbarPopoverMenuProps {
  caps: VideoControlCaps;
  mode: VideoMode;
  duration: number;
  resolution: string;
  ratio: string;
  quality?: VideoQuality;
  generateAudio: boolean;
  watermark?: boolean;
  onModeChange: (mode: VideoMode) => void;
  onDurationChange: (duration: number) => void;
  onResolutionChange: (resolution: string) => void;
  onRatioChange: (ratio: string) => void;
  onQualityChange?: (quality: VideoQuality) => void;
  onGenerateAudioChange: (generateAudio: boolean) => void;
  onWatermarkChange?: (watermark: boolean) => void;
  referenceLimitLabel?: (mode: VideoMode) => string;
  /** fill：占满剩余宽度、放不下时截断参数摘要（画布节点单排底栏）；content：按内容宽，交给外层横滚。 */
  fit?: 'fill' | 'content';
}

/** 生成方式 / 比例 / 清晰度（或档位）/ 生成时长 / 生成音频 多合一：
 * 收起态是一颗摘要按钮（首尾帧 · 16:9 · 480p · 5s · 🔊），点击弹出分区面板。
 * 分区按 caps 渲染：modes 只有一种隐藏生成方式；resolutions 为空隐藏清晰度；qualities 存在显示档位。
 */
export function VideoControls({
  caps,
  mode,
  duration,
  resolution,
  ratio,
  quality,
  generateAudio,
  watermark = false,
  onModeChange,
  onDurationChange,
  onResolutionChange,
  onRatioChange,
  onQualityChange,
  onGenerateAudioChange,
  onWatermarkChange,
  referenceLimitLabel,
  menuDirection = 'up',
  portalContainerRef,
  fit = 'content',
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const effectiveQuality = quality ?? caps.qualities?.[0];
  const durationRange = durationRangeOf(caps.durations);
  const summary = [
    caps.ratios.length > 0 ? ratioLabel(ratio) : null,
    caps.resolutions.length > 0 ? resolution : null,
    caps.qualities && effectiveQuality ? VIDEO_QUALITY_LABELS[effectiveQuality] : null,
    caps.durations.length > 0 ? `${duration}s` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div ref={wrapRef} className={cn('relative', fit === 'fill' && 'min-w-0 flex-1')}>
      <Button variant="bare"
        type="button"
        aria-label="视频设置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          open ? 'border-border bg-secondary text-foreground' : 'border-border text-foreground hover:bg-secondary'
        }`}
      >
        <VideoIcon size="sm" className="shrink-0" aria-hidden />
        <span className="shrink-0">{VIDEO_MODE_LABELS[mode]}</span>
        {referenceLimitLabel && (
          <Hint label={referenceLimitLabel(mode)}><span className="shrink-0">
            <HelpIcon size="sm" className="text-muted-foreground" aria-hidden="true" />
          </span></Hint>
        )}
        {summary && <span className="truncate">{' · '}{summary}</span>}
        {caps.supportsAudio && (
          <SwapIcon swapKey={Boolean(generateAudio)}>
            {generateAudio
              ? <VolumeIcon size="sm" aria-hidden className="shrink-0" />
              : <MuteIcon size="sm" aria-hidden className="shrink-0 text-muted-foreground" />}
          </SwapIcon>
        )}
      </Button>

      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        autoFocus
        direction={menuDirection}
        portalContainerRef={portalContainerRef}
        data-testid="video-settings-popover"
        className={cn(
          portalContainerRef ? 'max-h-[55vh]' : 'max-h-[70vh]',
          'w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-3',
        )}
      >
        <div className="space-y-4">
            {caps.modes.length > 1 && (
              <Section title="生成方式">
                <Segmented aria-label="选择生成方式" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  {caps.modes.map((m) => (
                    <SegmentedItem key={m} value={String(m)} selected={mode === m} onSelect={() => onModeChange(m)}>
                      {VIDEO_MODE_LABELS[m]}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </Section>
            )}

            {caps.ratios.length > 0 && (
              <Section title="比例">
                <Segmented aria-label="选择比例" className={`grid ${caps.ratios.length > 5 ? 'grid-cols-4' : 'grid-cols-5'} gap-y-1 rounded-lg bg-popover p-1`}>
                  {caps.ratios.map((item) => (
                    <SegmentedItem key={item} value={String(item)} selected={ratio === item} onSelect={() => onRatioChange(item)} className="flex h-[43px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-xs hover:bg-secondary/60 transition-colors">
                      <RatioIcon ratio={item} box={16} />
                      <span>{ratioLabel(item)}</span>
                    </SegmentedItem>
                  ))}
                </Segmented>
              </Section>
            )}

            {caps.resolutions.length > 0 && (
              <Section title="清晰度">
                <Segmented aria-label="选择清晰度" className="grid h-9 auto-cols-fr grid-flow-col rounded-lg bg-popover p-0.5">
                  {caps.resolutions.map((item) => (
                    <SegmentedItem key={item} value={String(item)} selected={resolution === item} onSelect={() => onResolutionChange(item)}>
                      {item}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </Section>
            )}

            {caps.qualities && (
              <Section title="生成档位">
                <Segmented aria-label="选择生成档位" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  {caps.qualities.map((item) => (
                    <SegmentedItem key={item} value={String(item)} selected={effectiveQuality === item} onSelect={() => onQualityChange?.(item)}>
                      {VIDEO_QUALITY_LABELS[item]}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </Section>
            )}

            {caps.durations.length > 0 && (
              <Section title="生成时长">
                {durationRange ? (
                  <div className="flex items-start gap-3 px-1">
                    <div className="min-w-0 flex-1 pt-3.5">
                      <Slider
                        aria-label="生成时长"
                        min={durationRange.min}
                        max={durationRange.max}
                        step={1}
                        value={[duration]}
                        onValueChange={([next]) => { if (next !== duration) onDurationChange(next); }}
                      />
                      <SliderMarks
                        className="mt-2"
                        min={durationRange.min}
                        max={durationRange.max}
                        marks={durationMarks(durationRange.min, durationRange.max)}
                        value={duration}
                      />
                    </div>
                    <NumberInput
                      aria-label="生成时长（秒）"
                      min={durationRange.min}
                      max={durationRange.max}
                      unit="s"
                      value={duration}
                      onValueChange={onDurationChange}
                    />
                  </div>
                ) : (
                  <Segmented aria-label="选择生成时长" className="grid h-9 auto-cols-fr grid-flow-col rounded-lg bg-popover p-0.5">
                    {caps.durations.map((item) => (
                      <SegmentedItem key={item} value={String(item)} selected={duration === item} onSelect={() => onDurationChange(item)}>
                        {item}s
                      </SegmentedItem>
                    ))}
                  </Segmented>
                )}
              </Section>
            )}

            {caps.supportsAudio && (
              <Section title="生成音频">
                <Segmented aria-label="生成音频开关" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  <SegmentedItem selected={generateAudio} onSelect={() => onGenerateAudioChange(true)} value="开启">
                    开启
                  </SegmentedItem>
                  <SegmentedItem selected={!generateAudio} onSelect={() => onGenerateAudioChange(false)} value="关闭">
                    关闭
                  </SegmentedItem>
                </Segmented>
              </Section>
            )}

            {caps.supportsWatermark && onWatermarkChange && (
              <Section title="视频水印">
                <Segmented aria-label="视频水印开关" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  <SegmentedItem selected={watermark} onSelect={() => onWatermarkChange(true)} value="开启">
                    开启
                  </SegmentedItem>
                  <SegmentedItem selected={!watermark} onSelect={() => onWatermarkChange(false)} value="关闭">
                    关闭
                  </SegmentedItem>
                </Segmented>
              </Section>
            )}
          </div>
      </ToolbarPopover>
    </div>
  );
}

/** 刻度：两端 + 区间内 5 的倍数（3–15 → 3 5 10 15）；离两端不足 10% 的中间刻度省掉，免得数字挤在一起（3–30 → 3 10 15 …）。 */
function durationMarks(min: number, max: number): number[] {
  const gap = (max - min) * 0.1;
  const marks = [min];
  for (let mark = Math.ceil((min + 1) / 5) * 5; mark < max; mark += 5) {
    if (mark - min >= gap && max - mark >= gap) marks.push(mark);
  }
  return [...marks, max];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="w-[296px]">
      <div className="py-1 px-1 text-xs text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}
