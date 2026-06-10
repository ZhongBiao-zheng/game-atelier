import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Clapperboard, Volume2, VolumeX } from 'lucide-react';
import {
  VIDEO_MODE_LABELS,
  type VideoControlCaps,
  type VideoMode,
} from '@/lib/videoControlCaps';
import { RatioIcon } from './RatioIcon';

interface Props {
  caps: VideoControlCaps;
  mode: VideoMode;
  duration: number;
  resolution: string;
  ratio: string;
  generateAudio: boolean;
  onModeChange: (mode: VideoMode) => void;
  onDurationChange: (duration: number) => void;
  onResolutionChange: (resolution: string) => void;
  onRatioChange: (ratio: string) => void;
  onGenerateAudioChange: (generateAudio: boolean) => void;
  menuDirection?: 'up' | 'down';
}

const VIDEO_MODES: VideoMode[] = ['firstlast', 'omni'];

/** 生成方式 / 比例 / 清晰度 / 生成时长 / 生成音频 五合一：
 * 收起态是一颗摘要按钮（首尾帧 · 16:9 · 480p · 5s · 🔊），点击弹出分区面板。
 */
export function VideoControls({
  caps,
  mode,
  duration,
  resolution,
  ratio,
  generateAudio,
  onModeChange,
  onDurationChange,
  onResolutionChange,
  onRatioChange,
  onGenerateAudioChange,
  menuDirection = 'up',
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelPosition = menuDirection === 'down' ? 'top-full mt-3' : 'bottom-full mb-3';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label="视频生成设置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          open ? 'border-border bg-secondary text-foreground' : 'border-border bg-background/30 text-foreground hover:bg-secondary'
        }`}
      >
        <Clapperboard size={14} aria-hidden />
        <span className="truncate">
          {VIDEO_MODE_LABELS[mode]} · {ratio} · {resolution} · {duration}s
        </span>
        {caps.supportsAudio && (
          generateAudio
            ? <Volume2 size={13} aria-hidden className="shrink-0" />
            : <VolumeX size={13} aria-hidden className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div
          data-testid="video-settings-popover"
          className={`absolute left-0 ${panelPosition} z-20 w-[320px] max-h-[70vh] overflow-y-auto rounded-2xl bg-secondary p-3 shadow-2xl ring-1 ring-border`}
        >
          <div className="space-y-4">
            <Section title="生成方式">
              <div role="listbox" aria-label="选择生成方式" className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-card p-0.5">
                {VIDEO_MODES.map((m) => (
                  <SegmentButton key={m} selected={mode === m} onClick={() => onModeChange(m)}>
                    {VIDEO_MODE_LABELS[m]}
                  </SegmentButton>
                ))}
              </div>
            </Section>

            <Section title="比例">
              <div role="listbox" aria-label="选择比例" className="flex gap-1 rounded-2xl bg-card p-1">
                {caps.ratios.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={ratio === item}
                    onClick={() => onRatioChange(item)}
                    className="flex h-[43px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-xs hover:bg-secondary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                  >
                    <RatioIcon ratio={item} box={16} />
                    <span>{item}</span>
                  </button>
                ))}
              </div>
            </Section>

            <Section title="清晰度">
              <div role="listbox" aria-label="选择清晰度" className={`grid h-9 ${caps.resolutions.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-1 rounded-2xl bg-card p-0.5`}>
                {caps.resolutions.map((item) => (
                  <SegmentButton key={item} selected={resolution === item} onClick={() => onResolutionChange(item)}>
                    {item}
                  </SegmentButton>
                ))}
              </div>
            </Section>

            <Section title="生成时长">
              <div role="listbox" aria-label="选择生成时长" className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-card p-0.5">
                {caps.durations.map((item) => (
                  <SegmentButton key={item} selected={duration === item} onClick={() => onDurationChange(item)}>
                    {item}s
                  </SegmentButton>
                ))}
              </div>
            </Section>

            {caps.supportsAudio && (
              <Section title="生成音频">
                <div role="listbox" aria-label="生成音频开关" className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-card p-0.5">
                  <SegmentButton selected={generateAudio} onClick={() => onGenerateAudioChange(true)}>
                    开启
                  </SegmentButton>
                  <SegmentButton selected={!generateAudio} onClick={() => onGenerateAudioChange(false)}>
                    关闭
                  </SegmentButton>
                </div>
              </Section>
            )}
          </div>
        </div>
      )}
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
      className="h-8 rounded-xl text-center text-sm hover:bg-secondary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
    >
      {children}
    </button>
  );
}
