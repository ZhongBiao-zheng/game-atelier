import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { Job } from '@/schema/jobs';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, motionAvailable, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 生成中的转圈：占位卡与完成交接层共用，交接时位置、样子都不变。 */
export const ROUND_SPINNER_CLASS = 'size-6 animate-spin rounded-full border-2 border-primary border-t-transparent';


// ---- 渐近进度 ----
// 上游任务查询不回真实进度（Ark / 可灵 / HappyHorse 只有状态枚举，2026-06-12 查证），只能按预期耗时近似：
// 预期耗时的前 60% 线性推进，之后指数逼近 90%，衔接处斜率连续；产物下载中推到 95%，完成时冲满。
const PROGRESS_LINEAR_END = 0.6;
const PROGRESS_CAP = 0.9;
const PROGRESS_DOWNLOADING = 0.95;
/** 指数段走到离 90% 只差 1/300 的时刻就停下不再动画，之后静止贴近 90%。 */
const PROGRESS_SETTLE_FACTOR = Math.log(300);
/** 指数段用折线近似：采样点越多越平滑，16 段在 2px 细条上已看不出折角。 */
const PROGRESS_SAMPLES = 16;
const IMAGE_EXPECTED_MS = 60_000;

/** 预期耗时：图片约 60s；视频按时长估（基础 90s + 每秒成片 10s）。 */
export function expectedDurationMs(kind: 'image' | 'video' | undefined, durationSec?: number): number {
  return kind === 'video' ? (90 + (durationSec ?? 5) * 10) * 1000 : IMAGE_EXPECTED_MS;
}

export function estimatedProgress(elapsedMs: number, expectedMs: number): number {
  if (elapsedMs <= 0) return 0;
  const linearEnd = PROGRESS_LINEAR_END * expectedMs;
  if (elapsedMs <= linearEnd) return elapsedMs / expectedMs;
  const tau = (PROGRESS_CAP - PROGRESS_LINEAR_END) * expectedMs;
  return PROGRESS_CAP - (PROGRESS_CAP - PROGRESS_LINEAR_END) * Math.exp(-(elapsedMs - linearEnd) / tau);
}

function progressSettleMs(expectedMs: number): number {
  return expectedMs * (PROGRESS_LINEAR_END + (PROGRESS_CAP - PROGRESS_LINEAR_END) * PROGRESS_SETTLE_FACTOR);
}

/** 细条当前画在哪：动画中途换阶段时从这里接着走，不跳回曲线上的理论值。 */
function currentScaleX(element: HTMLElement): number | null {
  const match = getComputedStyle(element).transform.match(/^matrix\(\s*([^,\s]+)/);
  return match ? Number(match[1]) : null;
}

/** 每轮细条最后画到的位置（按轮次 key）：占位卡换成完成交接层时细条是新挂的元素，
 *  读不到旧条的 transform，从这里接上旧条的实际进度。完成层卸载时清掉。 */
const drawnProgress = new Map<string, number>();

/** 占位卡底部 2px 渐近进度条。只动 transform: scaleX，零重排；complete 时 200ms 冲满。
 *  进度只增不减：换阶段、换卡都从已画到的位置接着走。 */
export function ProgressLine({ startedAt, expectedMs, phase, held = false, complete = false, progressKey }: {
  startedAt: number;
  expectedMs: number;
  phase?: Job['progress_phase'];
  /** 还没提交上游（视频素材准备中）：停在起点。 */
  held?: boolean;
  complete?: boolean;
  /** 所属轮次的稳定 key：占位与完成交接层传同一个，完成层从占位细条画到的位置起冲。 */
  progressKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const setScale = (value: number) => { element.style.transform = `scaleX(${value})`; };
    const elapsed = Date.now() - startedAt;
    const carried = (progressKey && drawnProgress.get(progressKey)) || 0;
    const estimate = held ? 0 : estimatedProgress(elapsed, expectedMs);
    const target = Math.max(carried, complete ? 1 : phase === 'downloading' ? PROGRESS_DOWNLOADING : estimate);
    // 卸载或换阶段时记下画到的位置；value 要在停动画之前读，停了之后读到的是内联终值。
    const remember = (value: number | null) => {
      if (!progressKey) return;
      if (complete) drawnProgress.delete(progressKey);
      else if (value != null) drawnProgress.set(progressKey, Math.max(drawnProgress.get(progressKey) ?? 0, value));
    };
    if (!motionAvailable()) {
      setScale(target);
      return;
    }
    const from = Math.max(carried, currentScaleX(element) ?? estimate);
    // 写 transform 整串而不是 scaleX 简写：走 WAAPI 在合成线程跑，长达几分钟的推进不占主线程。
    // 终值先写进内联样式，动画播完（或中途被下一段接管）后停在原处。
    const scales = (values: number[]) => values.map(value => `scaleX(${value})`);
    let controls: AnimationPlaybackControls;
    if (complete || phase === 'downloading') {
      setScale(target);
      controls = animate(element, { transform: scales([from, target]) }, {
        duration: complete ? MOTION_DURATION.base : MOTION_DURATION.slow,
        ease: MOTION_EASE.out,
      });
    } else {
      const settle = progressSettleMs(expectedMs);
      const start = Math.max(elapsed, 0);
      if (held || start >= settle) {
        setScale(Math.max(from, target));
        return () => remember(currentScaleX(element));
      }
      const span = settle - start;
      const times = Array.from({ length: PROGRESS_SAMPLES + 1 }, (_, index) => index / PROGRESS_SAMPLES);
      const values = times.map((time, index) => index === 0 ? from : Math.max(from, estimatedProgress(start + time * span, expectedMs)));
      setScale(values[values.length - 1]);
      controls = animate(element, { transform: scales(values) }, { duration: span / 1000, times, ease: 'linear' });
    }
    return () => {
      const value = currentScaleX(element);
      controls.stop();
      if (value != null) setScale(value);
      remember(value);
    };
  }, [startedAt, expectedMs, phase, held, complete, progressKey]);
  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="progress-line"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary"
    />
  );
}

/** 阶段角标的文案：只在排队、等网关、下载、准备素材这些真实阶段换字，其余一律「生成中…」。 */
export function stageLabel(phase: Job['progress_phase'] | undefined, isVideo: boolean): string {
  if (phase === 'waiting_gateway') return '等待网关中…';
  if (phase?.startsWith('queued:')) return `排队第 ${phase.slice(7)} 位`;
  if (phase === 'downloading') return '下载中…';
  if (isVideo && !phase) return '准备中…';
  return '生成中…';
}

/** 完成交接层：结果卡在占位的同一个比例框里挂上，先垫着占位的转圈与冲满的细条，
 *  结果解码后在它上面淡入（200ms），淡入播完再卸掉这一层，全程不露空白。 */
export function CompletionUnderlay({ revealed, startedAt, expectedMs, progressKey }: {
  revealed: boolean;
  startedAt: number;
  expectedMs: number;
  progressKey?: string;
}) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setGone(true), MOTION_DURATION.base * 1000);
    return () => clearTimeout(timer);
  }, [revealed]);
  if (gone) return null;
  return (
    <div aria-hidden data-testid="completion-underlay" className="absolute inset-0 flex items-center justify-center bg-card/40">
      <div className={ROUND_SPINNER_CLASS} />
      <ProgressLine startedAt={startedAt} expectedMs={expectedMs} progressKey={progressKey} complete />
    </div>
  );
}

/** 结果卡的比例框：先沿用提交时的目标比例（与占位卡同一个框），读到媒体真实尺寸后改用真实比例
 *  （AUTO 尺寸只能等这一刻）。目标比例与真实比例一致时没有任何跳动。 */
export function useResultAspect(fallback: CSSProperties) {
  const [natural, setNatural] = useState<string | null>(null);
  const style: CSSProperties = natural ? { aspectRatio: natural } : fallback;
  const onSize = (width: number, height: number) => {
    if (width > 0 && height > 0) setNatural(`${width} / ${height}`);
  };
  return [style, onSize] as const;
}

/** 结果视频：首帧可显示（loadeddata）后淡入，消除黑帧闪烁。preload=metadata 时部分浏览器
 *  （Safari）不取首帧，只发 suspend；拿到元数据后的 suspend 也算就绪，不让视频永远透明。 */
export function ResultVideo({ src, onSize, onReady }: {
  src: string;
  onSize: (width: number, height: number) => void;
  onReady: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const latestOnReady = useRef(onReady);
  latestOnReady.current = onReady;
  // 已缓存、挂载时就有首帧的视频直接显示，不播淡入。
  useLayoutEffect(() => {
    const video = ref.current;
    if (video && video.readyState >= 2) setReady(true);
  }, [src]);
  useEffect(() => {
    if (ready) latestOnReady.current();
  }, [ready]);
  return (
    <video
      ref={ref}
      src={src}
      controls
      preload="metadata"
      playsInline
      onLoadedMetadata={event => onSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
      onLoadedData={() => setReady(true)}
      onSuspend={event => { if (event.currentTarget.readyState >= 1) setReady(true); }}
      onError={() => setReady(true)}
      className={cn('relative h-full w-full transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0')}
    />
  );
}

/** 一轮记录的外层：新到达的那一轮入场（透明度 + 8px 上移，200ms out），删除时先淡出（150ms subtle）再移除。
 *  enter 只在挂载时读一次；往上加载的历史与首屏都传 false，不动。 */
export function RoundEnter({ enter, leaving, children }: { enter: boolean; leaving: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const enterOnMount = useRef(enter);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enterOnMount.current || !element || !motionAvailable()) return;
    const controls = prefersReducedMotion()
      ? animate(element, { opacity: [0, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle })
      : animate(element, { opacity: [0, 1], y: [8, 0] }, { duration: MOTION_DURATION.base, ease: MOTION_EASE.out });
    clearOnFinish(controls, element);
    return () => controls.stop();
  }, []);
  return (
    <div ref={ref} className={leaving ? 'opacity-0 transition-opacity duration-150' : undefined}>
      {children}
    </div>
  );
}

/** 删除前先让整轮淡出：等淡出播完再真正删，删除失败时恢复。 */
export function useLeavingRounds() {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const removeAfterFade = async (key: string, remove: () => void | Promise<void>) => {
    setLeaving(current => new Set(current).add(key));
    if (motionAvailable()) await new Promise(resolve => setTimeout(resolve, MOTION_DURATION.fast * 1000));
    try {
      await remove();
    } finally {
      // 删除成功时与移除这一轮的状态更新同批提交，不会先闪回不透明。
      setLeaving(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  return [leaving, removeAfterFade] as const;
}
