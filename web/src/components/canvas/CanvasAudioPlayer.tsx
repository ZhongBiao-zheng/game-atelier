import { useEffect, useRef, useState } from 'react';
import { FastForward, Pause, Play, Rewind } from 'lucide-react';
import { request } from '@/api/http';
import { SwapIcon } from '@/components/ui/swap-icon';
import { cn } from '@/lib/utils';

/** 每根波形条代表的最短时长；长音频按 MAX_BARS 摊开，避免几千根条。 */
const MIN_SECONDS_PER_BAR = 0.2;
const MAX_BARS = 1500;
const BAR_WIDTH = 6;
const BAR_GAP = 4;
const BAR_PITCH = BAR_WIDTH + BAR_GAP;
const SKIP_SECONDS = 5;

type Waveform = { peaks: number[]; secondsPerBar: number };

// 同一音频在画布上可能有多个节点，节点滚出视口还会卸载重挂；按地址缓存解码结果。
const waveformCache = new Map<string, Promise<Waveform>>();

async function decodeWaveform(src: string): Promise<Waveform> {
  const response = await request(src, '读取音频波形');
  const buffer = await response.arrayBuffer();
  // OfflineAudioContext 解码不需要用户手势，也不占用音频输出设备。
  const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buffer);
  const secondsPerBar = Math.max(MIN_SECONDS_PER_BAR, audio.duration / MAX_BARS);
  const samplesPerBar = Math.max(1, Math.floor(audio.sampleRate * secondsPerBar));
  const channel = audio.getChannelData(0);
  const peaks: number[] = [];
  for (let start = 0; start < channel.length; start += samplesPerBar) {
    const end = Math.min(channel.length, start + samplesPerBar);
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += channel[index] * channel[index];
    peaks.push(Math.sqrt(sum / (end - start)));
  }
  const max = Math.max(...peaks, 1e-6);
  return { peaks: peaks.map(peak => peak / max), secondsPerBar };
}

function useWaveform(src: string): Waveform | null {
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  useEffect(() => {
    if (!src || typeof OfflineAudioContext === 'undefined') return;
    let alive = true;
    let pending = waveformCache.get(src);
    if (!pending) {
      pending = decodeWaveform(src);
      waveformCache.set(src, pending);
      pending.catch(() => waveformCache.delete(src));
    }
    // 波形只是播放位置的示意：解码失败时保留平直的占位条，播放本身走 <audio>，不受影响。
    pending.then(result => { if (alive) setWaveform(result); }, () => undefined);
    return () => { alive = false; };
  }, [src]);
  return waveform;
}

function formatClock(seconds: number) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * 画布音频节点的播放器：播放头固定在中间，波形随播放向左走。
 * 只有按钮是 nodrag，其余区域拖动照常移动节点；单击波形跳到对应位置。
 */
export function CanvasAudioPlayer({
  src,
  title,
  mediaRef,
}: {
  src: string;
  title: string;
  mediaRef: (element: HTMLElement | null) => void;
}) {
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const waveElement = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [waveWidth, setWaveWidth] = useState(0);
  const waveform = useWaveform(src);
  const label = title || '音频';


  useEffect(() => {
    const element = waveElement.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWaveWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // timeupdate 每秒只来约 4 次，波形会一跳一跳；播放期间按帧读位置。
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioElement.current;
      if (audio) setCurrentTime(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const seek = (seconds: number) => {
    const audio = audioElement.current;
    if (!audio) return;
    const next = Math.min(Math.max(0, seconds), duration || audio.duration || 0);
    audio.currentTime = next;
    setCurrentTime(next);
  };
  const togglePlayback = () => {
    const audio = audioElement.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  };
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  const secondsPerBar = waveform?.secondsPerBar ?? MIN_SECONDS_PER_BAR;
  const barCount = waveform?.peaks.length ?? Math.ceil(duration / secondsPerBar);
  const playheadBar = currentTime / secondsPerBar;
  const halfVisible = Math.ceil(waveWidth / 2 / BAR_PITCH) + 1;
  const firstBar = Math.max(0, Math.floor(playheadBar) - halfVisible);
  const lastBar = Math.min(barCount, Math.ceil(playheadBar) + halfVisible);
  const bars: { index: number; peak: number }[] = [];
  for (let index = firstBar; index < lastBar; index += 1) {
    bars.push({ index, peak: waveform?.peaks[index] ?? 0 });
  }

  return (
    // 懒加载观察整个播放器：没有 controls 的 <audio> 是 display:none，IntersectionObserver 永远报不可见。
    <div ref={mediaRef} data-canvas-media className="relative flex size-full min-h-0 flex-col gap-3 px-4 pb-3 pt-5">
      <audio
        ref={audioElement}
        src={src}
        preload={src ? 'metadata' : 'none'}
        data-canvas-media-controls="audio"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={event => {
          setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
          setCurrentTime(event.currentTarget.currentTime);
        }}
        onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
      />
      <div className="relative min-h-0 flex-1">
        <div
          ref={waveElement}
          className="canvas-audio-wave absolute inset-0 overflow-hidden"
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            // 节点随画布缩放，按渲染宽度与布局宽度的比例换回布局像素。
            const scale = rect.width / (event.currentTarget.offsetWidth || rect.width);
            const offset = (event.clientX - rect.left - rect.width / 2) / scale;
            seek(currentTime + (offset / BAR_PITCH) * secondsPerBar);
          }}
        >
          {bars.map(({ index, peak }) => (
            <span
              key={index}
              aria-hidden="true"
              className={cn(
                'absolute top-1/2 -translate-y-1/2 rounded-full',
                index < playheadBar ? 'bg-foreground/80' : 'bg-foreground/25',
              )}
              style={{
                left: `calc(50% + ${(index - playheadBar) * BAR_PITCH}px)`,
                width: BAR_WIDTH,
                height: `max(3px, ${Math.round(peak * 80)}%)`,
              }}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 flex-col items-center" aria-hidden="true">
          <span className="size-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-primary" />
          <span className="w-0.5 flex-1 rounded-full bg-primary" />
          <span
            className={cn(
              'absolute top-full mt-1 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs tabular-nums text-primary-foreground transition-opacity',
              playing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {formatClock(currentTime)}/{formatClock(duration)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-center gap-6 pt-4">
        <button
          type="button"
          aria-label={`后退 ${SKIP_SECONDS} 秒 ${label}`}
          className="nodrag grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={event => { stop(event); seek(currentTime - SKIP_SECONDS); }}
        >
          <Rewind className="size-4 fill-current" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`${playing ? '暂停' : '播放'} ${label}`}
          className="nodrag grid size-10 place-items-center rounded-full bg-foreground text-background transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={event => { stop(event); togglePlayback(); }}
        >
          <SwapIcon swapKey={playing}>
            {playing
              ? <Pause className="size-4 fill-current" aria-hidden="true" />
              : <Play className="ml-0.5 size-4 fill-current" aria-hidden="true" />}
          </SwapIcon>
        </button>
        <button
          type="button"
          aria-label={`前进 ${SKIP_SECONDS} 秒 ${label}`}
          className="nodrag grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={event => { stop(event); seek(currentTime + SKIP_SECONDS); }}
        >
          <FastForward className="size-4 fill-current" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
