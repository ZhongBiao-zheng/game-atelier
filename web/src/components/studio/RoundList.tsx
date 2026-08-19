import { type ButtonHTMLAttributes, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Download, Eye, EyeOff, Film, Heart, Info, Music, Pencil, Trash2, X } from 'lucide-react';

import type { MjParams } from '@/lib/mjParams';
import type { VideoFrameMode } from '@/lib/videoControlCaps';
import { useVideoFrame } from '@/lib/videoFrame';
import type { GenMode } from '@/lib/historyFilters';
import { isGalleryFavorited, isGalleryHidden } from '@/api/gallery';
import { formatBeijingTime } from '@/lib/time';

import { WaitingCopy } from './WaitingCopy';

export interface RoundConfig {
  prompt: string;
  kind?: 'image' | 'video';
  alias?: string | null;
  provider?: string | null;
  model: string;
  modelName?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  quality?: 'low' | 'medium' | 'high' | 'auto';
  size?: string;
  n?: number;
  referenceImages: string[];
  /** MJ 专属参数（family=midjourney）——「编辑导入 / 再次生成」靠它还原画师当时的选择，
   *  否则会拿默认值静默重出一张不一样的图。 */
  mjParams?: MjParams;
  /** 后端回写的真实 flag 串（如 "--ar 4:3 --v 8.2 --chaos 10"）。MJ 的参数全在 flag 里，
   *  不摊开显示的话画师从卡片上看不出这张是按什么参数出的。只读。 */
  mjFlags?: string;
  // 后端在跑 job 时回写的静默改写提示（尺寸被归一化 / 参考图被截断…）；只读展示，前端不产生。
  warnings?: string[];
  // 视频参数（kind=video）—— 再次生成时按原 job 完整还原；resolution 是图片语义（2K/4K），视频分辨率另存。
  duration?: number;
  videoResolution?: string;
  videoQuality?: 'std' | 'pro';
  frameMode?: VideoFrameMode;
  generateAudio?: boolean;
  referenceVideos?: string[];
  referenceAudios?: string[];
}

export type RoundState =
  | {
      kind: 'pending';
      mode?: GenMode;
      jobId?: string;
      startedAt: number;
      // 后端回写的真实进度卡点（sent=已提交上游 / downloading=产物下载中），无 job 或未提交时为空。
      progressPhase?: 'sent' | 'downloading' | null;
      config: RoundConfig;
    }
  | { kind: 'done'; mode?: GenMode; jobId: string; submittedAt: string; completedAt?: string | null; imagePaths: string[]; config: RoundConfig }
  | { kind: 'failed'; mode?: GenMode; jobId?: string; submittedAt: string; reason: string; config?: RoundConfig };

/** 生成中占位框的宽高比：按目标比例（"16:9"）→ 退回尺寸（"1024x1536"）→ 退回 1:1。
 *  别再固定 aspect-square，否则出竖图/宽图时占位是方框、出图后尺寸跳变。 */
function aspectStyle(config: RoundConfig): { aspectRatio: string } {
  const r = config.ratio;
  if (r && /^\d+\s*:\s*\d+$/.test(r)) return { aspectRatio: r.replace(/\s*:\s*/, ' / ') };
  const m = config.size?.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (m) return { aspectRatio: `${m[1]} / ${m[2]}` };
  return { aspectRatio: '1 / 1' };
}

export function RoundList({
  rounds,
  favorites,
  onToggleFavorite,
  hiddenPaths,
  onToggleHidden,
  onDeleteFailed,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
  onReuseReferences,
  onEditAsReference,
}: {
  rounds: RoundState[];
  favorites?: string[];
  onToggleFavorite?: (path: string) => void | Promise<void>;
  hiddenPaths?: string[];
  onToggleHidden?: (path: string) => void | Promise<void>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onReuseReferences?: (paths: string[]) => void | Promise<void>;
  onEditAsReference?: (path: string) => void | Promise<void>;
}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (rounds.length === 0) return null;
  return (
    <>
      <div
        data-testid="studio-round-list"
        className="mx-auto mt-8 w-full min-w-[800px] max-w-[1024px] space-y-8 text-left"
      >
        {rounds.map((r) => {
          const stableKey =
            r.kind === 'pending' && r.jobId ? `pending-${r.jobId}` :
            r.kind === 'pending' ? `pending-${r.startedAt}` :
            `${r.kind}-${r.submittedAt}`;
          return (
            // data-round-job：首页作品深链（/studio?job=）滚动定位的锚点。
            <div key={stableKey} data-round-job={r.jobId ?? undefined}>
              {r.kind === 'pending' && (
                <div className="mb-3">
                  <WaitingCopy startedAt={r.startedAt} />
                </div>
              )}
              {r.kind === 'pending' && (
                <section className="space-y-3">
                  <div className="flex items-start gap-3 text-sm">
                    <ReferenceStack refs={allRefs(r.config)} onReuse={onReuseReferences} />
                    <div className="min-w-0 flex-1">
                      <MentionPrompt prompt={r.config.prompt} config={r.config} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Array.from({ length: Math.max(1, r.config.n ?? 1) }, (_, i) => (
                      <div
                        key={i}
                        data-testid={i === 0 && r.jobId ? `studio-pending-${r.jobId}` : undefined}
                        data-skeleton
                        aria-busy="true"
                        style={aspectStyle(r.config)}
                        className="relative w-[251.5px] bg-card/40 rounded-lg flex items-center justify-center"
                      >
                        <ProgressBadge round={r} />
                        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <ActionButton onClick={() => onReEdit?.(r.config)}>重新编辑</ActionButton>
                    <ActionButton onClick={() => { void onRegenerate?.(r.config); }}>再次生成</ActionButton>
                    {r.jobId && onDeleteFailed && (
                      <ActionButton compact aria-label="删除出图记录" title="删除出图记录" onClick={() => { void onDeleteFailed(r.jobId!); }}>
                        <Trash2 className="size-4" />
                      </ActionButton>
                    )}
                  </div>
                </section>
              )}
              {r.kind === 'done' && (
                <DoneBatch
                  round={r}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  hiddenPaths={hiddenPaths}
                  onToggleHidden={onToggleHidden}
                  onReEdit={onReEdit}
                  onRegenerate={onRegenerate}
                  onDeleteBatch={onDeleteBatch}
                  onLightbox={setLightboxSrc}
                  onReuseReferences={onReuseReferences}
                  onEditAsReference={onEditAsReference}
                />
              )}
              {r.kind === 'failed' && (
                <FailedCard
                  round={r}
                  onDeleteFailed={onDeleteFailed}
                  onReEdit={onReEdit}
                  onRegenerate={onRegenerate}
                  onReuseReferences={onReuseReferences}
                />
              )}
            </div>
          );
        })}
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

/** 进度卡点 → 百分比。
 *
 * 真实信号：sent=20（任务已提交上游）、downloading=95（产物下载中）、终态时卡片整体切换。
 * 中段（50/75）按预期时长的时间卡点跳变 —— 上游任务查询不回真实进度（Ark/可灵/HappyHorse
 * 均只有状态枚举，2026-06-12 查证），只能用预期时间近似。
 * 图片任务无提交/下载拆分（同步单调用）：纯时间卡点 20→50→75，封顶 90 等 DONE。
 */
function progressPercent(opts: {
  isVideo: boolean;
  phase: 'sent' | 'downloading' | null | undefined;
  startedAt: number;
  durationSec?: number;
  now: number;
}): number {
  const { isVideo, phase, startedAt, durationSec, now } = opts;
  if (phase === 'downloading') return 95;
  if (isVideo && !phase) return 0; // 素材准备中（含本地参考视频 OSS 中转），还没提交上游
  const expectedMs = isVideo ? (90 + (durationSec ?? 5) * 10) * 1000 : 60_000;
  const elapsed = now - startedAt;
  if (!isVideo && elapsed >= expectedMs) return 90;
  if (elapsed >= expectedMs * 0.75) return 75;
  if (elapsed >= expectedMs * 0.5) return 50;
  return 20;
}

function ProgressBadge({ round }: { round: Extract<RoundState, { kind: 'pending' }> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const percent = progressPercent({
    isVideo: round.config.kind === 'video',
    phase: round.progressPhase,
    startedAt: round.startedAt,
    durationSec: round.config.duration,
    now,
  });
  return (
    <span
      data-testid="progress-badge"
      className="absolute left-2 top-2 rounded-full bg-scrim px-2.5 py-1 text-xs text-white backdrop-blur-glass"
    >
      {percent}% 生成中
    </span>
  );
}

function imageSrc(path: string) {
  return `/api/gallery/image?path=${encodeURIComponent(path)}`;
}

// 视频复用与图片相同的字节端点（output_paths 白名单内）。
function videoSrc(path: string) {
  return `/api/gallery/image?path=${encodeURIComponent(path)}`;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(path);
}

function isAudioPath(path: string): boolean {
  return /\.(mp3|wav|m4a|ogg)(\?|#|$)/i.test(path);
}

// 参考素材三类来源，分流到对应字节端点：
// - http(s) CDN 直链：原样返回
// - characters/* 与 studio/* 资产（skill 出图的参考＝角色立绘）：走 /api/gallery/image，
//   与结果图同端点（/api/raw 不带 job_id 只放行 .runtime/uploads/，角色绝对路径会 403 裂图）
// - 其余（.runtime/uploads/ 的画师临时上传）：走 /api/raw
function refImageSrc(path: string) {
  if (path.startsWith('http')) return path;
  if (/\/(characters|studio)\//.test(path)) {
    return `/api/gallery/image?path=${encodeURIComponent(path)}`;
  }
  return `/api/raw?path=${encodeURIComponent(path)}`;
}

// 历史参考堆叠合并三类素材（视频 round 常只有视频/音频参考，单看图片会整组消失）。
function allRefs(config: RoundConfig): string[] {
  return [
    ...config.referenceImages,
    ...(config.referenceVideos ?? []),
    ...(config.referenceAudios ?? []),
  ];
}

const REF_CARD_W = 46;
const REF_CARD_H = 58;
const REF_ROTATIONS = [-6, 5, -4, 7, -5, 4, -3, 6];
const REF_OVERLAP_REST = 30;
const REF_OVERLAP_HOVER = 8;

// 出图历史里提示词左侧的参考图堆叠：未 hover 重叠旋转成一叠；hover 时整组散开、每张以中心为轴放大；点击整组复用。
function ReferenceStack({
  refs,
  onReuse,
}: {
  refs: string[];
  onReuse?: (paths: string[]) => void | Promise<void>;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  if (refs.length === 0) return null;
  return (
    <button
      type="button"
      data-testid="reference-stack"
      title="点击复用这组参考素材"
      aria-label="复用这组参考素材"
      onClick={() => { void onReuse?.(refs); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(null); }}
      className="group relative z-20 flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0"
    >
      {refs.map((src, i) => {
        const angle = REF_ROTATIONS[i % REF_ROTATIONS.length];
        const isActive = active === i;
        const scale = isActive ? 1.18 : hover ? 1.1 : 1;
        return (
          <span
            key={i}
            onMouseEnter={() => setActive(i)}
            style={{
              width: REF_CARD_W,
              height: REF_CARD_H,
              marginLeft: i === 0 ? 0 : -(hover ? REF_OVERLAP_HOVER : REF_OVERLAP_REST),
              zIndex: isActive ? 30 : i,
              transform: `rotate(${angle}deg) scale(${scale})`,
              transformOrigin: 'center',
              transition: 'transform 250ms ease, margin-left 250ms ease',
            }}
            className="relative block overflow-hidden rounded-lg border-[1.5px] border-white bg-card"
          >
            <RefThumb src={src} />
          </span>
        );
      })}
    </button>
  );
}

// ---- 提示词 @引用只读 chip（与输入框 PromptInput 的 chip 同款视觉）----

// 提交链路会把 @视频1 序列化成 视频1（厂商契约要的形态），job 里存的是序列化后的
// prompt —— 所以这里 @ 可选；误伤靠「只有对应参考素材真实存在才 chip 化」兜底。
const MENTION_TOKEN_RE = /@?(图|视频|音频)(\d+)/g;
type MentionKind = 'image' | 'video' | 'audio';
const MENTION_KIND: Record<string, MentionKind> = { 图: 'image', 视频: 'video', 音频: 'audio' };

function mentionRefPath(config: RoundConfig, kind: MentionKind, n: number): string | null {
  const list = kind === 'image' ? config.referenceImages
    : kind === 'video' ? config.referenceVideos
    : config.referenceAudios;
  return list?.[n - 1] ?? null;
}

type MentionHover = { kind: MentionKind; path: string; left: number; top: number };

/** 历史记录里的提示词：@图N/@视频N/@音频N 渲染成缩略图+标签 chip，hover 在上方浮层预览。 */
function MentionPrompt({ prompt, config }: { prompt: string; config: RoundConfig }) {
  const [hover, setHover] = useState<MentionHover | null>(null);
  const parts = useMemo(() => {
    const out: Array<string | { label: string; kind: MentionKind; path: string }> = [];
    let last = 0;
    for (const m of prompt.matchAll(MENTION_TOKEN_RE)) {
      // 引用的素材不存在 → 当普通文本，不 chip 化（防止正文里碰巧出现"视频1"被误伤）。
      const path = mentionRefPath(config, MENTION_KIND[m[1]], parseInt(m[2], 10));
      if (!path) continue;
      if (m.index! > last) out.push(prompt.slice(last, m.index));
      out.push({ label: `${m[1]}${m[2]}`, kind: MENTION_KIND[m[1]], path });
      last = m.index! + m[0].length;
    }
    if (last < prompt.length) out.push(prompt.slice(last));
    return out;
  }, [prompt, config]);

  return (
    <>
      <p className="line-clamp-2 text-base leading-7 text-foreground" title={prompt}>
        {parts.map((part, i) =>
          typeof part === 'string' ? (
            <span key={i}>{part}</span>
          ) : (
            <MentionChip key={i} label={part.label} kind={part.kind} path={part.path} onHover={setHover} />
          ),
        )}
      </p>
      {hover && createPortal(
        <div
          data-testid="round-mention-preview"
          className="fixed z-50 pointer-events-none"
          style={{ left: hover.left, top: hover.top - 8, transform: 'translate(-50%, -100%)' }}
        >
          {hover.kind === 'video' ? (
            <video
              src={refImageSrc(hover.path)}
              autoPlay
              muted
              loop
              playsInline
              className="h-[150px] rounded-lg border border-border bg-card"
            />
          ) : hover.kind === 'image' ? (
            <img
              src={refImageSrc(hover.path)}
              alt=""
              className="h-[150px] rounded-lg border border-border bg-card object-contain"
            />
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              <Music className="size-4" aria-hidden />
              <span className="max-w-[180px] truncate">{hover.path.split('/').pop()}</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function MentionChip({ label, kind, path, onHover }: {
  label: string;
  kind: MentionKind;
  path: string;
  onHover: (h: MentionHover | null) => void;
}) {
  const frame = useVideoFrame(kind === 'video' ? refImageSrc(path) : null);
  const thumb = kind === 'image' ? refImageSrc(path) : frame;
  return (
    <span
      data-mention={label}
      className="inline-flex select-none items-center gap-1 align-middle text-primary"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onHover({ kind, path, left: r.left + r.width / 2, top: r.top });
      }}
      onMouseLeave={() => onHover(null)}
    >
      {thumb ? (
        <img src={thumb} alt="" className="h-[18px] w-[18px] rounded-sm object-cover" />
      ) : kind !== 'image' ? (
        <span className="grid h-[18px] w-[18px] place-items-center rounded-sm bg-secondary text-muted-foreground">
          {kind === 'video' ? <Film className="size-3" aria-hidden /> : <Music className="size-3" aria-hidden />}
        </span>
      ) : null}
      {label}
    </span>
  );
}

// 堆叠卡内容：图片直出、视频抽首帧（失败退回 Film 图标）、音频固定 Music 图标。
function RefThumb({ src }: { src: string }) {
  const isImage = isImagePath(src);
  const isAudio = !isImage && isAudioPath(src);
  const frame = useVideoFrame(!isImage && !isAudio ? refImageSrc(src) : null);
  const thumb = isImage ? refImageSrc(src) : frame;
  if (thumb) {
    return <img src={thumb} alt="参考素材" className="h-full w-full object-cover" draggable={false} />;
  }
  return (
    <span className="flex h-full w-full items-center justify-center bg-card text-muted-foreground">
      {isAudio ? <Music className="size-4" /> : <Film className="size-4" />}
    </span>
  );
}

function DoneBatch({
  round,
  favorites,
  onToggleFavorite,
  hiddenPaths,
  onToggleHidden,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
  onLightbox,
  onReuseReferences,
  onEditAsReference,
}: {
  round: Extract<RoundState, { kind: 'done' }>;
  favorites?: string[];
  onToggleFavorite?: (path: string) => void | Promise<void>;
  hiddenPaths?: string[];
  onToggleHidden?: (path: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onLightbox?: (src: string) => void;
  onReuseReferences?: (paths: string[]) => void | Promise<void>;
  onEditAsReference?: (path: string) => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);
  const elapsedSec =
    round.completedAt && round.submittedAt
      ? Math.max(0, Math.round((Date.parse(round.completedAt) - Date.parse(round.submittedAt)) / 1000))
      : null;
  // 两行分层：出图参数（模型/尺寸/比例/清晰度/张数）是主元信息；耗时 + 生成时间是运行信息，
  // 降到更小更淡的次行，别和参数挤在一行。
  const specMeta = [
    round.config.modelName ?? round.config.model,
    round.config.size,
    round.config.ratio,
    round.config.resolution,
    round.config.n && round.config.n > 1 ? `${round.config.n} 张` : undefined,
  ].filter(Boolean);
  const runMeta = [
    elapsedSec != null ? `耗时 ${elapsedSec}s` : undefined,
    round.completedAt ? formatBeijingTime(round.completedAt) : undefined,
  ].filter(Boolean);

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3 text-sm">
        <ReferenceStack refs={allRefs(round.config)} onReuse={onReuseReferences} />
        <div className="min-w-0 flex-1">
          <MentionPrompt prompt={round.config.prompt} config={round.config} />
          <p className="mt-1 text-sm text-muted-foreground">
            {specMeta.join(' · ')}
            {round.config.mjFlags && (
              <span data-testid="round-mj-flags" className="ml-2 text-muted-foreground/60">
                {round.config.mjFlags}
              </span>
            )}
          </p>
          {runMeta.length > 0 && (
            <p data-testid="round-run-meta" className="mt-0.5 text-xs text-muted-foreground/60">
              {runMeta.join(' · ')}
            </p>
          )}
          {/* 后端回写的静默改写提示（尺寸归一化 / 参考图截断）——是提示不是错误，走 muted 灰不用暖红。 */}
          {(round.config.warnings?.length ?? 0) > 0 && (
            <ul data-testid="round-warnings" className="mt-1.5 space-y-1">
              {round.config.warnings!.map((warning, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-px size-3 shrink-0" aria-hidden />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {round.config.kind === 'video'
          ? round.imagePaths.map((path, index) => {
              const favorited = !!favorites && isGalleryFavorited(path, favorites);
              return (
                <figure
                  key={path}
                  data-testid={`studio-result-video-${index + 1}`}
                  className="group relative w-[420px] max-w-full overflow-hidden rounded-md bg-card"
                >
                  <video
                    src={videoSrc(path)}
                    controls
                    preload="metadata"
                    className="h-full w-full rounded-md"
                  />
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void onToggleFavorite?.(path); }}
                      aria-label={favorited ? '取消喜欢' : '喜欢'}
                      title={favorited ? '取消喜欢' : '喜欢'}
                      className={`grid size-8 place-items-center rounded-full border border-border bg-scrim backdrop-blur-glass transition-opacity hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${favorited ? 'text-primary opacity-100' : 'text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                    >
                      <Heart className={`size-4 ${favorited ? 'fill-current' : ''}`} aria-hidden />
                    </button>
                    <a
                      href={videoSrc(path)}
                      download={path.split('/').pop() || `${round.jobId}-${index + 1}.mp4`}
                      aria-label={`下载生成视频 ${index + 1}`}
                      title="下载视频"
                      className="grid size-8 place-items-center rounded-full border border-border bg-scrim text-white opacity-0 backdrop-blur-glass transition-opacity hover:bg-background/90 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Download className="size-4" aria-hidden />
                    </a>
                  </div>
                </figure>
              );
            })
          : round.imagePaths.map((path, index) => {
              const favorited = !!favorites && isGalleryFavorited(path, favorites);
              const hidden = !!hiddenPaths && isGalleryHidden(path, hiddenPaths);
              return (
                <figure
                  key={path}
                  data-testid={`studio-result-thumb-${index + 1}`}
                  className="group relative w-[251.5px] overflow-hidden rounded-md bg-card cursor-pointer"
                  onClick={() => onLightbox?.(imageSrc(path))}
                >
                  <img
                    src={imageSrc(path)}
                    alt={`生成结果 ${index + 1}`}
                    className="h-full w-full object-contain"
                  />
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void onToggleFavorite?.(path); }}
                      aria-label={favorited ? '取消喜欢' : '喜欢'}
                      title={favorited ? '取消喜欢' : '喜欢'}
                      className={`grid size-8 place-items-center rounded-full border border-border bg-scrim backdrop-blur-glass transition-opacity hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${favorited ? 'text-primary opacity-100' : 'text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                    >
                      <Heart className={`size-4 ${favorited ? 'fill-current' : ''}`} aria-hidden />
                    </button>
                    {onToggleHidden && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void onToggleHidden(path); }}
                        aria-label={hidden ? '取消隐藏' : '隐藏（不在首页展示）'}
                        title={hidden ? '取消隐藏' : '隐藏（不在首页展示）'}
                        className={`grid size-8 place-items-center rounded-full border border-border bg-scrim backdrop-blur-glass transition-opacity hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${hidden ? 'text-primary opacity-100' : 'text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                      >
                        {hidden ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                      </button>
                    )}
                    <a
                      href={imageSrc(path)}
                      download={path.split('/').pop() || `${round.jobId}-${index + 1}.png`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`下载生成结果 ${index + 1}`}
                      title="下载图片"
                      className="grid size-8 place-items-center rounded-full border border-border bg-scrim text-white opacity-0 backdrop-blur-glass transition-opacity hover:bg-background/90 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Download className="size-4" aria-hidden />
                    </a>
                  </div>
                  {/* 左下角编辑：把这张图导入下方输入框作参考图，继续图生图微调。 */}
                  {onEditAsReference && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void onEditAsReference(path); }}
                      aria-label={`编辑生成结果 ${index + 1}（导入为参考图）`}
                      title="编辑（导入为参考图）"
                      className="absolute bottom-2 left-2 grid size-8 place-items-center rounded-full border border-border bg-scrim text-white opacity-0 backdrop-blur-glass transition-opacity hover:bg-background/90 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Pencil className="size-4" aria-hidden />
                    </button>
                  )}
                </figure>
              );
            })}
      </div>
      <div className="flex items-center gap-2">
        <ActionButton onClick={() => onReEdit?.(round.config)}>重新编辑</ActionButton>
        <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
        {/* skill 出图（角色立绘/KV/三视图）在出图页只作溯源展示——删除会从磁盘抹掉角色资产，
            该操作只留在工坊页。这里仅对 studio 自家出图开放「删除该批次结果」。 */}
        {round.mode !== 'skill' && (
        <div className="relative" ref={menuWrapRef}>
          <ActionButton compact aria-label="更多操作" onClick={() => setMenuOpen((value) => !value)}>...</ActionButton>
          {menuOpen && (
            <div data-testid="studio-more-menu" className="absolute left-full top-0 z-10 ml-2 h-11 w-[195px] rounded-xl bg-glass backdrop-blur-glass border border-border p-0">
              <button
                type="button"
                aria-label="删除该批次结果"
                className="flex h-11 w-full items-center gap-2 rounded-xl px-3 py-[9px] text-left text-sm font-medium text-foreground hover:bg-secondary/80"
                onClick={() => {
                  setMenuOpen(false);
                  void onDeleteBatch?.(round.jobId, round.imagePaths);
                }}
              >
                <Trash2 className="size-4 shrink-0" aria-hidden />
                删除该批次结果
              </button>
            </div>
          )}
        </div>
        )}
      </div>
    </section>
  );
}

function ActionButton({
  compact = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { compact?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center ${compact ? 'h-9 w-9 px-0' : 'h-9 w-[94px] px-3'} rounded-md bg-secondary text-sm font-medium text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      {...props}
    />
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-glass"
      onClick={onClose}
    >
      <img
        src={src}
        alt="大图"
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={e => e.stopPropagation()}
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute right-6 top-6 size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-background/90 backdrop-blur-glass border-0"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}

function FailedCard({
  round,
  onDeleteFailed,
  onReEdit,
  onRegenerate,
  onReuseReferences,
}: {
  round: Extract<RoundState, { kind: 'failed' }>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onReuseReferences?: (paths: string[]) => void | Promise<void>;
}) {
  const { config } = round;
  const meta = config
    ? [
        config.modelName ?? config.model,
        config.size,
        config.ratio,
        config.resolution,
        config.n && config.n > 1 ? `${config.n} 张` : undefined,
      ].filter(Boolean)
    : [];

  return (
    <section className="space-y-3">
      {config && (
        <div className="flex items-start gap-3 text-sm">
          <ReferenceStack refs={allRefs(config)} onReuse={onReuseReferences} />
          <div className="min-w-0 flex-1">
            <MentionPrompt prompt={config.prompt} config={config} />
            {meta.length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">{meta.join(' | ')}</p>
            )}
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive/70" aria-hidden />
        <p className="flex-1 text-muted-foreground">{round.reason}</p>
        {round.jobId && onDeleteFailed && (
          <button
            type="button"
            aria-label="删除失败记录"
            title="删除失败记录"
            onClick={() => { void onDeleteFailed(round.jobId!); }}
            className="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            删除
          </button>
        )}
      </div>
      {config && (
        <div className="flex items-center gap-2">
          <ActionButton onClick={() => onReEdit?.(config)}>重新编辑</ActionButton>
          <ActionButton onClick={() => { void onRegenerate?.(config); }}>再次生成</ActionButton>
        </div>
      )}
    </section>
  );
}
