import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';
import { Clapperboard, Clock, Film, Frame, Maximize, Volume2 } from 'lucide-react';
import {
  FRAME_MODE_LABELS,
  VIDEO_MODE_LABELS,
  type VideoControlCaps,
  type VideoFrameMode,
  type VideoMode,
} from '@/lib/videoControlCaps';

interface Props {
  caps: VideoControlCaps;
  mode: VideoMode;
  duration: number;
  resolution: string;
  ratio: string;
  frameMode: VideoFrameMode;
  generateAudio: boolean;
  onModeChange: (mode: VideoMode) => void;
  onDurationChange: (duration: number) => void;
  onResolutionChange: (resolution: string) => void;
  onRatioChange: (ratio: string) => void;
  onFrameModeChange: (frameMode: VideoFrameMode) => void;
  onGenerateAudioChange: (generateAudio: boolean) => void;
  menuDirection?: 'up' | 'down';
}

const VIDEO_MODES: VideoMode[] = ['t2v', 'i2v', 'ref', 'v2v'];

type PanelKey = 'mode' | 'duration' | 'resolution' | 'ratio' | 'frame' | null;

export function VideoControls({
  caps,
  mode,
  duration,
  resolution,
  ratio,
  frameMode,
  generateAudio,
  onModeChange,
  onDurationChange,
  onResolutionChange,
  onRatioChange,
  onFrameModeChange,
  onGenerateAudioChange,
  menuDirection = 'up',
}: Props) {
  const [openPanel, setOpenPanel] = useState<PanelKey>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelPosition = menuDirection === 'down' ? 'top-full mt-3' : 'bottom-full mb-3';

  useEffect(() => {
    if (!openPanel) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenPanel(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openPanel]);

  return (
    <div ref={wrapRef} className="flex min-w-0 flex-wrap gap-2">
      {/* 模式选择 */}
      <div className="relative">
        <ControlButton
          active={openPanel === 'mode'}
          aria-label="选择视频模式"
          onClick={() => setOpenPanel(openPanel === 'mode' ? null : 'mode')}
        >
          <Clapperboard size={14} aria-hidden /> {VIDEO_MODE_LABELS[mode]}
        </ControlButton>
        {openPanel === 'mode' && (
          <div role="listbox" aria-label="视频模式列表" className={`absolute left-0 ${panelPosition} z-20 w-[200px] rounded-2xl border border-border bg-secondary p-2 shadow-2xl`}>
            {VIDEO_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={mode === m}
                onClick={() => { onModeChange(m); setOpenPanel(null); }}
                className="flex h-10 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-card aria-selected:bg-card aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
              >
                {VIDEO_MODE_LABELS[m]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 时长 */}
      <PopoverControl
        panelKey="duration"
        openPanel={openPanel}
        setOpenPanel={setOpenPanel}
        panelPosition={panelPosition}
        ariaLabel="选择时长"
        listLabel="时长列表"
        icon={<Clock size={14} aria-hidden />}
        buttonText={`${duration}s`}
        options={caps.durations.map((d) => ({ key: d, label: `${d}s`, selected: d === duration, onSelect: () => onDurationChange(d) }))}
      />

      {/* 分辨率 */}
      <PopoverControl
        panelKey="resolution"
        openPanel={openPanel}
        setOpenPanel={setOpenPanel}
        panelPosition={panelPosition}
        ariaLabel="选择分辨率"
        listLabel="分辨率列表"
        icon={<Maximize size={14} aria-hidden />}
        buttonText={resolution}
        options={caps.resolutions.map((r) => ({ key: r, label: r, selected: r === resolution, onSelect: () => onResolutionChange(r) }))}
      />

      {/* 画幅比例 */}
      <PopoverControl
        panelKey="ratio"
        openPanel={openPanel}
        setOpenPanel={setOpenPanel}
        panelPosition={panelPosition}
        ariaLabel="选择画幅比例"
        listLabel="画幅比例列表"
        icon={<Film size={14} aria-hidden />}
        buttonText={ratio}
        options={caps.ratios.map((r) => ({ key: r, label: r, selected: r === ratio, onSelect: () => onRatioChange(r) }))}
      />

      {/* 帧模式（仅图生视频） */}
      {mode === 'i2v' && (
        <PopoverControl
          panelKey="frame"
          openPanel={openPanel}
          setOpenPanel={setOpenPanel}
          panelPosition={panelPosition}
          ariaLabel="选择帧模式"
          listLabel="帧模式列表"
          icon={<Frame size={14} aria-hidden />}
          buttonText={FRAME_MODE_LABELS[frameMode]}
          options={caps.frameModes.map((f) => ({ key: f, label: FRAME_MODE_LABELS[f], selected: f === frameMode, onSelect: () => onFrameModeChange(f) }))}
        />
      )}

      {/* 生成音频开关 */}
      {caps.supportsAudio && (
        <ControlButton
          active={generateAudio}
          aria-label="生成音频"
          aria-pressed={generateAudio}
          onClick={() => onGenerateAudioChange(!generateAudio)}
        >
          <Volume2 size={14} aria-hidden /> 音频
        </ControlButton>
      )}
    </div>
  );
}

interface OptionSpec {
  key: string | number;
  label: string;
  selected: boolean;
  onSelect: () => void;
}

function PopoverControl({
  panelKey,
  openPanel,
  setOpenPanel,
  panelPosition,
  ariaLabel,
  listLabel,
  icon,
  buttonText,
  options,
}: {
  panelKey: Exclude<PanelKey, null>;
  openPanel: PanelKey;
  setOpenPanel: (p: PanelKey) => void;
  panelPosition: string;
  ariaLabel: string;
  listLabel: string;
  icon: ReactNode;
  buttonText: string;
  options: OptionSpec[];
}) {
  return (
    <div className="relative">
      <ControlButton
        active={openPanel === panelKey}
        aria-label={ariaLabel}
        onClick={() => setOpenPanel(openPanel === panelKey ? null : panelKey)}
      >
        {icon} {buttonText}
      </ControlButton>
      {openPanel === panelKey && (
        <div role="listbox" aria-label={listLabel} className={`absolute left-0 ${panelPosition} z-20 flex flex-wrap gap-1 rounded-2xl border border-border bg-secondary p-2 shadow-2xl`}>
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="option"
              aria-selected={opt.selected}
              onClick={() => { opt.onSelect(); setOpenPanel(null); }}
              className="inline-flex h-9 min-w-[44px] items-center justify-center rounded-xl border border-border bg-background/30 px-3 text-sm font-medium transition-colors hover:bg-card aria-selected:bg-secondary aria-selected:border-primary/60 aria-selected:ring-1 aria-selected:ring-primary/60"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ControlButton({
  active,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active ? 'border-border bg-secondary text-foreground' : 'border-border bg-background/30 text-foreground hover:bg-secondary'
      } ${className}`}
      {...props}
    />
  );
}
