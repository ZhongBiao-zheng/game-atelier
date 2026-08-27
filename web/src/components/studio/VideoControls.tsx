import { useRef, useState, type ReactNode } from 'react';
import { CircleHelp, Clapperboard, Volume2, VolumeX } from 'lucide-react';
import {
  VIDEO_MODE_LABELS,
  VIDEO_QUALITY_LABELS,
  ratioLabel,
  type VideoControlCaps,
  type VideoMode,
  type VideoQuality,
} from '@/lib/videoControlCaps';
import { RatioIcon } from './RatioIcon';
import { ToolbarPopover, type ToolbarPopoverMenuProps } from './ToolbarPopover';
import { cn } from '@/lib/utils';

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
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const effectiveQuality = quality ?? caps.qualities?.[0];
  const summary = [
    caps.ratios.length > 0 ? ratioLabel(ratio) : null,
    caps.resolutions.length > 0 ? resolution : null,
    caps.qualities && effectiveQuality ? VIDEO_QUALITY_LABELS[effectiveQuality] : null,
    caps.durations.length > 0 ? `${duration}s` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label="视频设置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          open ? 'border-border bg-secondary text-foreground' : 'border-border text-foreground hover:bg-secondary'
        }`}
      >
        <Clapperboard size={14} aria-hidden />
        <span className="shrink-0">{VIDEO_MODE_LABELS[mode]}</span>
        {referenceLimitLabel && (
          <span className="group/help relative shrink-0" title={referenceLimitLabel(mode)}>
            <CircleHelp className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-max max-w-72 -translate-x-1/2 rounded-lg border border-border bg-popover px-2 py-1.5 text-xs font-normal leading-relaxed text-foreground opacity-0 transition-opacity group-hover/help:opacity-100 group-focus-within/help:opacity-100"
            >
              {referenceLimitLabel(mode)}
            </span>
          </span>
        )}
        {summary && <span className="truncate">{' · '}{summary}</span>}
        {caps.supportsAudio && (
          generateAudio
            ? <Volume2 size={13} aria-hidden className="shrink-0" />
            : <VolumeX size={13} aria-hidden className="shrink-0 text-muted-foreground" />
        )}
      </button>

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
                <div role="listbox" aria-label="选择生成方式" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  {caps.modes.map((m) => (
                    <SegmentButton key={m} selected={mode === m} onClick={() => onModeChange(m)}>
                      {VIDEO_MODE_LABELS[m]}
                    </SegmentButton>
                  ))}
                </div>
              </Section>
            )}

            {caps.ratios.length > 0 && (
              <Section title="比例">
                <div role="listbox" aria-label="选择比例" className={`grid ${caps.ratios.length > 5 ? 'grid-cols-4' : 'grid-cols-5'} gap-y-1 rounded-lg bg-popover p-1`}>
                  {caps.ratios.map((item) => (
                    <button
                      key={item}
                      type="button"
                      role="option"
                      aria-selected={ratio === item}
                      onClick={() => onRatioChange(item)}
                      className="flex h-[43px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-xs hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                    >
                      <RatioIcon ratio={item} box={16} />
                      <span>{ratioLabel(item)}</span>
                    </button>
                  ))}
                </div>
              </Section>
            )}

            {caps.resolutions.length > 0 && (
              <Section title="清晰度">
                <div role="listbox" aria-label="选择清晰度" className={`grid h-9 ${caps.resolutions.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'} rounded-lg bg-popover p-0.5`}>
                  {caps.resolutions.map((item) => (
                    <SegmentButton key={item} selected={resolution === item} onClick={() => onResolutionChange(item)}>
                      {item}
                    </SegmentButton>
                  ))}
                </div>
              </Section>
            )}

            {caps.qualities && (
              <Section title="生成档位">
                <div role="listbox" aria-label="选择生成档位" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  {caps.qualities.map((item) => (
                    <SegmentButton key={item} selected={effectiveQuality === item} onClick={() => onQualityChange?.(item)}>
                      {VIDEO_QUALITY_LABELS[item]}
                    </SegmentButton>
                  ))}
                </div>
              </Section>
            )}

            {caps.durations.length > 0 && (
              <Section title="生成时长">
                {/* seedance/happyhorse 官方是连续整数秒（最多 4-15 共 12 档），多于 4 档改 6 列多行铺开 */}
                <div
                  role="listbox"
                  aria-label="选择生成时长"
                  className={`grid ${caps.durations.length > 4 ? 'grid-cols-6 gap-0.5' : 'h-9 grid-cols-2'} rounded-lg bg-popover p-0.5`}
                >
                  {caps.durations.map((item) => (
                    <SegmentButton key={item} selected={duration === item} onClick={() => onDurationChange(item)}>
                      {item}s
                    </SegmentButton>
                  ))}
                </div>
              </Section>
            )}

            {caps.supportsAudio && (
              <Section title="生成音频">
                <div role="listbox" aria-label="生成音频开关" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  <SegmentButton selected={generateAudio} onClick={() => onGenerateAudioChange(true)}>
                    开启
                  </SegmentButton>
                  <SegmentButton selected={!generateAudio} onClick={() => onGenerateAudioChange(false)}>
                    关闭
                  </SegmentButton>
                </div>
              </Section>
            )}

            {caps.supportsWatermark && onWatermarkChange && (
              <Section title="视频水印">
                <div role="listbox" aria-label="视频水印开关" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                  <SegmentButton selected={watermark} onClick={() => onWatermarkChange(true)}>
                    开启
                  </SegmentButton>
                  <SegmentButton selected={!watermark} onClick={() => onWatermarkChange(false)}>
                    关闭
                  </SegmentButton>
                </div>
              </Section>
            )}
          </div>
      </ToolbarPopover>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="w-[296px]">
      <div className="py-1 px-1 text-xs text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function SegmentButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className="h-8 rounded-md text-center text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
    >
      {children}
    </button>
  );
}
