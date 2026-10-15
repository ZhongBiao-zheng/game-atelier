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
/** 指针移动不超过这个距离（布局像素）算单击，跳到点中的位置；超过算拖动。 */
const SCRUB_CLICK_SLOP = 3;
/** 前进 / 后退按钮把音频分成三段：开头、中间、结尾。 */
const SEGMENT_EPSILON = 0.05;

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

/** 静音条高度 2–6px，按序号取伪随机值：同一位置每次渲染一样，拖动时不闪。 */
function silenceBarHeight(index: number) {
  const noise = Math.abs(Math.sin(index * 12.9898) * 43758.5453) % 1;
  return 2 + Math.round(noise * 4);
}

function formatClock(seconds: number) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * 画布音频节点的播放器：播放头固定在中间，波形随播放向左走。
 * 波形区与按钮是 nodrag（拖波形调进度），其余边缘区域拖动移动节点。
 * 前进 / 后退在开头、中间、结尾三处之间跳。
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
  const scrub = useRef<{ pointerId: number; startX: number; startTime: number; scale: number; moved: boolean } | null>(null);
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
      // 拖动波形期间以指针位置为准；audio 的 seek 落地有延迟，读回来会让波形来回抖。
      if (audio && !scrub.current?.moved) setCurrentTime(audio.currentTime);
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
  const stops = [0, duration / 2, duration];
  const nextStop = stops.find(time => time > currentTime + SEGMENT_EPSILON) ?? duration;
  const previousStop = [...stops].reverse().find(time => time < currentTime - SEGMENT_EPSILON) ?? 0;

  const secondsPerBar = waveform?.secondsPerBar ?? MIN_SECONDS_PER_BAR;
  const barCount = waveform?.peaks.length ?? Math.ceil(duration / secondsPerBar);
  const playheadBar = currentTime / secondsPerBar;
  const halfVisible = Math.ceil(waveWidth / 2 / BAR_PITCH) + 1;
  // 开头之前、结尾之后也铺满：用低矮的静音条补齐，播放头在两端时两侧不会空着。
  const firstBar = Math.floor(playheadBar) - halfVisible;
  const lastBar = Math.ceil(playheadBar) + halfVisible;
  const bars: { index: number; peak: number | null }[] = [];
  for (let index = firstBar; index < lastBar; index += 1) {
    const inside = index >= 0 && index < barCount;
    bars.push({ index, peak: inside ? waveform?.peaks[index] ?? 0 : null });
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
        onTimeUpdate={event => { if (!scrub.current?.moved) setCurrentTime(event.currentTarget.currentTime); }}
      />
      <div className="relative min-h-0 flex-1">
        <div
          ref={waveElement}
          // 波形区是播放器自己的进度条：nodrag 不让画布拖节点，左右拖动波形调进度，单击跳到点中的位置。
          className="canvas-audio-wave nodrag nowheel absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const rect = event.currentTarget.getBoundingClientRect();
            scrub.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startTime: currentTime,
              // 节点随画布缩放，按渲染宽度与布局宽度的比例换回布局像素。
              scale: rect.width / (event.currentTarget.offsetWidth || rect.width),
              moved: false,
            };
          }}
          onPointerMove={event => {
            const active = scrub.current;
            if (!active || active.pointerId !== event.pointerId) return;
            const offset = (event.clientX - active.startX) / active.scale;
            if (!active.moved && Math.abs(offset) <= SCRUB_CLICK_SLOP) return;
            active.moved = true;
            // 播放头固定在中间，波形跟着指针走：往左拖是往后听。
            seek(active.startTime - (offset / BAR_PITCH) * secondsPerBar);
          }}
          onPointerUp={event => {
            const active = scrub.current;
            if (!active || active.pointerId !== event.pointerId) return;
            scrub.current = null;
            if (active.moved) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const offset = (event.clientX - rect.left - rect.width / 2) / active.scale;
            seek(active.startTime + (offset / BAR_PITCH) * secondsPerBar);
          }}
          onPointerCancel={() => { scrub.current = null; }}
          onClick={stop}
          onDoubleClick={stop}
        >
          {bars.map(({ index, peak }) => (
            <span
              key={index}
              aria-hidden="true"
              className={cn(
                'absolute top-1/2 -translate-y-1/2 rounded-full',
                peak === null
                  ? 'bg-foreground/15'
                  : index < playheadBar ? 'bg-foreground/80' : 'bg-foreground/25',
              )}
              style={{
                left: `calc(50% + ${(index - playheadBar) * BAR_PITCH}px)`,
                width: BAR_WIDTH,
                height: peak === null ? silenceBarHeight(index) : `max(3px, ${Math.round(peak * 80)}%)`,
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
          aria-label={`跳到上一段 ${label}`}
          className="nodrag grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={event => { stop(event); seek(previousStop); }}
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
          aria-label={`跳到下一段 ${label}`}
          className="nodrag grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={event => { stop(event); seek(nextStop); }}
        >
          <FastForward className="size-4 fill-current" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
