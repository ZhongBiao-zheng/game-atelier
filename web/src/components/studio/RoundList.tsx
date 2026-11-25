import type { PromptPreviewRequest } from '@/components/assets/SetPromptPreviewDialog';
import type { Job, JobParams } from '@/schema/jobs';
import { type ButtonHTMLAttributes, forwardRef, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AddImageIcon, AudioIcon, BookmarkIcon, DeleteIcon, DownloadIcon, EditIcon, FavoriteIcon, HideIcon, InfoIcon, MoreIcon, SaveAssetIcon, ShareIcon, ShowIcon, StopIcon, TextIcon, VideoIcon, WarningIcon, WorkflowIcon } from '@/components/ui/icons';

import type { MjParams } from '@/lib/mjParams';
import type { VideoFrameMode } from '@/lib/videoControlCaps';
import { useVideoFrame } from '@/lib/videoFrame';
import type { AgentRound, GenMode, TimelineRound } from '@/lib/historyFilters';
import { isGalleryFavorited, isGalleryHidden } from '@/api/gallery';
import { formatBeijingTime } from '@/lib/time';
import { formatGenerationCost } from '@/lib/generationCost';
import { MetaTag } from '@/components/MetaTag';
import { ModelBrandIcon } from '@/components/ModelBrandIcon';
import { modelBrand, modelDisplayName } from '@/lib/modelCatalog';
import { COMPLEXITY_LABELS, QUALITY_LABELS } from '@/lib/imageControlCaps';
import { gifSummary } from './GptImage26Fields';
import { VIDEO_QUALITY_LABELS, ratioLabel } from '@/lib/videoControlCaps';
import type { RoundParameter } from '@/pages/studioParameterReuse';
import { imageSizeSummary } from '@/lib/imageSizeMode';
import { failureSummary } from '@/lib/failureSummary';
import {
  canonicalMentionLabel,
  createMentionTokenRegex,
  mentionKindFromToken,
  type MentionKind,
} from '@/lib/mentionTokens';

import { Lightbox } from '../Lightbox';
import {
  CompletionUnderlay,
  expectedDurationMs,
  ProgressLine,
  ResultVideo,
  ROUND_SPINNER_CLASS,
  RoundEnter,
  stageLabel,
  useLeavingRounds,
  useResultAspect,
} from './RoundMotion';
import { AnimatePresence, motion } from 'motion/react';
import { MOTION_DURATION, MOTION_EASE } from '@/lib/motion';
import { RevealImage } from '@/components/ui/reveal-image';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const HISTORY_BATCH_SIZE = 30;
const MEDIA_ROOT_MARGIN = '600px 0px';
const HISTORY_LOAD_ROOT_MARGIN = '800px 0px 0px';

export interface RoundConfig {
  workflowInputs?: JobParams['workflow_inputs'];
  prompt: string;
  kind?: 'image' | 'video';
  alias?: string | null;
  provider?: string | null;
  model: string;
  modelName?: string;
  ratio?: string;
  resolution?: '512' | '1K' | '2K' | '4K';
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  /** GPT Image 2.6：规划强度与 GIF 输出，字段名与 JobParams 一致，再次生成时原样回填。 */
  complexity?: 'low' | 'medium' | 'high';
  output_format?: 'gif';
  frame_count?: number;
  frame_duration_ms?: number;
  /** Seedream 5.5：transparent = 强制透明背景（其余值不展示）。 */
  background?: JobParams['background'];
  size?: string;
  sizeMode?: 'auto' | 'ratio' | 'custom';
  n?: number;
  referenceImages: string[];
  /** 使用创作资产时冻结的只读来源名称；不提供回跳或更新关系。 */
  sourceAssetTitle?: string;
  promptAssetId?: string;
  /** MJ 专属参数（family=midjourney）——「编辑导入 / 再次生成」靠它还原画师当时的选择，
   *  否则会拿默认值静默重出一张不一样的图。 */
  mjParams?: MjParams;
  /** 后端回写的真实 flag 串（如 "--ar 4:3 --v 8.2 --chaos 10"）。MJ 的参数全在 flag 里，
   *  不摊开显示的话画师从卡片上看不出这张是按什么参数出的。只读。 */
  mjFlags?: string;
  /** MJ 三个语义参考图的服务器路径（风格 / 角色 / Omni）——「再次生成」按原图复用，
   *  不带上就等于静默丢掉参考图重出一张。 */
  mjRefPaths?: { sref?: string[]; cref?: string[]; oref?: string[] };
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

export type RoundState = (
  | {
      kind: 'pending';
      mode?: GenMode;
      jobId?: string;
      startedAt: number;
      // 后端回写的真实进度卡点（sent=已提交上游 / downloading=产物下载中），无 job 或未提交时为空。
      progressPhase?: Job['progress_phase'];
      // 已按「停止」：后端登记了 cancel_requested_at，等 runner 在可中断点落 canceled。
      cancelRequested?: boolean;
      config: RoundConfig;
    }
  | {
      kind: 'done';
      mode?: GenMode;
      jobId: string;
      submittedAt: string;
      completedAt?: string | null;
      imagePaths: string[];
      generationCost?: number;
      /** job.namespace === 'studio'：只有 Studio 自家出图能分享到团队库。 */
      shareable?: boolean;
      config: RoundConfig;
    }
  // canceled=画师主动停止（不是错误）：同一张卡，去掉警示色。
  | { kind: 'failed'; mode?: GenMode; jobId?: string; submittedAt: string; reason: string; canceled?: boolean; config?: RoundConfig }
) & {
  /** 本地提交时生成的客户端 id：占位、服务端任务、完成始终用它作 key，整卡不重挂。 */
  clientKey?: string;
};

/** 一轮记录的稳定 key：客户端 id 优先，其次 job_id。
 *  对话轮用 client_message_id：乐观轮与服务端确认后的正式轮共用它（turn_id 会从占位 id 换成正式 id），
 *  确认时整轮不重挂、不重播入场；正式 turn_id 仍只用于服务端操作。会话维度由 Studio 按会话 ID 给整个列表上 key。 */
function roundKey(round: TimelineRound): string {
  if (round.kind === 'agent') return `agent:${round.turn.client_message_id}`;
  if (round.clientKey) return round.clientKey;
  if (round.jobId) return round.jobId;
  return round.kind === 'pending' ? `pending-${round.startedAt}` : `${round.kind}-${round.submittedAt}`;
}

/** 生成中占位框的宽高比：按目标比例（"16:9"）→ 退回尺寸（"1024x1536"）→ 退回 1:1。
 *  别再固定 aspect-square，否则出竖图/宽图时占位是方框、出图后尺寸跳变。 */
// 一条记录上下三段：信息（提示词 + 参数标签）→ 结果 → 操作。
const ROUND_SECTION_CLASS = 'space-y-3';
const ROUND_HEADER_CLASS = 'flex flex-col gap-3 text-sm';
// 参考图只占提示词这一行的左侧——标签行与操作行始终从最左缘开始，有没有参考图都一样。
const ROUND_PROMPT_ROW_CLASS = 'flex items-start gap-4';
const ROUND_MEDIA_CLASS = 'flex flex-wrap gap-1';
const ROUND_ACTIONS_CLASS = 'flex flex-wrap items-center gap-2';
const ROUND_RUN_META_CLASS = 'flex items-center gap-1.5 border-l border-border pl-3 text-xs tabular-nums text-muted-foreground';

function aspectStyle(config: RoundConfig): { aspectRatio: string } {
  const r = !config.sizeMode || config.sizeMode === 'ratio' ? config.ratio : undefined;
  if (r && /^\d+\s*:\s*\d+$/.test(r)) return { aspectRatio: r.replace(/\s*:\s*/, ' / ') };
  const m = config.sizeMode !== 'auto' ? config.size?.match(/^(\d+)\s*[x×]\s*(\d+)$/i) : null;
  if (m) return { aspectRatio: `${m[1]} / ${m[2]}` };
  return { aspectRatio: '1 / 1' };
}

type ParameterReuse = (config: RoundConfig, parameter: RoundParameter) => (() => void) | string | undefined;

function SpecChips({ config, reuseParameter, testId, children }: {
  config: RoundConfig; reuseParameter?: ParameterReuse; testId?: string; children?: ReactNode;
}) {
  const video = config.kind === 'video';
  const values: Array<{ parameter: RoundParameter; label: string }> = [
    { parameter: 'model', label: config.provider === 'chatgpt' ? 'GPT Image' : modelDisplayName({ id: config.model, name: config.modelName }) },
  ];
  const add = (parameter: RoundParameter, label: string | undefined) => {
    if (label) values.push({ parameter, label });
  };
  add('size', video ? config.ratio && ratioLabel(config.ratio)
    : config.sizeMode === 'auto' || config.ratio || config.size
      ? imageSizeSummary({ size_mode: config.sizeMode ?? (!config.ratio && config.size !== 'auto' ? 'custom' : undefined), size: config.size, ratio: config.ratio }) : undefined);
  add('resolution', video ? config.videoResolution : config.resolution);
  if (video) add('duration', config.duration != null ? `${config.duration}s` : undefined);
  add('quality', video ? config.videoQuality && VIDEO_QUALITY_LABELS[config.videoQuality]
    : config.quality && QUALITY_LABELS[config.quality]);
  if (!video) {
    add('complexity', config.complexity && `规划 ${COMPLEXITY_LABELS[config.complexity]}`);
    add('gif', gifSummary(config) ?? undefined);
    add('background', config.background === 'transparent' ? '透明背景' : undefined);
  }
  add('count', config.n != null ? `${config.n} 张` : undefined);
  if (video) add('audio', config.generateAudio != null ? config.generateAudio ? '有音频' : '无音频' : undefined);
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5 text-xs text-foreground">
      {config.provider === 'chatgpt' && <MetaTag>ChatGPT 订阅</MetaTag>}
      {values.map(({ parameter, label }) => {
        const result = reuseParameter?.(config, parameter);
        const apply = typeof result === 'function' ? result : undefined;
        return <MetaTag key={parameter} className="inline-flex items-center gap-1"
          onClick={apply ?? (() => undefined)} disabled={!apply} disabledReason={typeof result === 'string' ? result : undefined}>
          {parameter === 'model' && (config.model?.startsWith('comfyui-') ? <WorkflowIcon size="sm" aria-hidden /> : <ModelBrandIcon brand={modelBrand(config.model)} size="sm" />)}
          {label}
        </MetaTag>;
      })}
      {children}
    </div>
  );
}

/** 来源提示词资产：描边标签，和实底的参数标签区分开。 */
function SourceChip({ title, testId }: { title: string; testId?: string }) {
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-muted-foreground">
      <BookmarkIcon size="sm" className="shrink-0" aria-hidden />
      <span className="sr-only">来源：</span>{title}
    </span>
  );
}

/** 记录所属的北京日期（YYYY-MM-DD），日期分组用。 */
function roundDate(round: TimelineRound): string {
  const iso = round.kind === 'pending'
    ? new Date(round.startedAt).toISOString()
    : round.submittedAt;
  return formatBeijingTime(iso).slice(0, 10);
}

function shownMjMetadata(config: RoundConfig): string {
  const flags = visibleMjFlags(config.mjFlags);
  const srefCode = config.mjParams?.srefCode.trim();
  const profile = config.mjParams?.profile.trim();
  const seed = config.mjParams?.seed.trim();
  const additions: string[] = [];
  if (srefCode) {
    additions.push(`--sref ${srefCode}`);
    if (config.mjParams?.sw !== null && config.mjParams?.sw !== undefined) {
      additions.push(`--sw ${config.mjParams.sw}`);
    }
  }
  if (profile && !/(?:^|\s)--(?:profile|p)(?:\s|$)/.test(flags)) {
    additions.push(`--profile ${profile}`);
  }
  if (seed && !/(?:^|\s)--seed(?:\s|$)/.test(flags)) additions.push(`--seed ${seed}`);
  return [flags, ...additions].filter(Boolean).join(' ');
}

export function RoundList({
  embedded = false,
  rounds,
  renderAgent,
  focusJobId,
  focusHighlight = false,
  favorites,
  onToggleFavorite,
  hiddenPaths,
  onToggleHidden,
  onDeleteFailed,
  onCancel,
  onReEdit,
  reuseParameter,
  onRegenerate,
  onDeleteBatch,
  onReuseReferences,
  onEditAsReference,
  onSavePromptAsset,
  onSaveResultAsset,
  onShareResult,
  onSetPromptPreview,
}: {
  embedded?: boolean;
  rounds: TimelineRound[];
  renderAgent?: (round: AgentRound) => ReactNode;
  focusJobId?: string;
  /** 深链定位到目标轮后的提示描边：true 时主题色描边 300ms 进，回到 false 时 150ms 淡出。 */
  focusHighlight?: boolean;
  favorites?: string[];
  onToggleFavorite?: (path: string) => void | Promise<void>;
  hiddenPaths?: string[];
  onToggleHidden?: (path: string) => void | Promise<void>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onCancel?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  reuseParameter?: ParameterReuse;
  onRegenerate?: (config: RoundConfig, failedJobId?: string) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onReuseReferences?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  onEditAsReference?: (path: string) => void | Promise<void>;
  onSavePromptAsset?: (config: RoundConfig) => void;
  onSaveResultAsset?: SaveResultAssetHandler;
  /** index 是 imagePaths 下标（= Job.output_paths 下标），分享来源的 output_index 直接用它。 */
  onShareResult?: ShareResultHandler;
  onSetPromptPreview?: (request: PromptPreviewRequest) => void;
}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const lightboxItems = useMemo(() => rounds.flatMap((round) => (
    round.kind === 'done' && round.config.kind !== 'video'
      ? round.imagePaths.map((path, index) => ({
        src: imageSrc(path),
        config: round.config,
        name: path.split('/').pop() || `${round.jobId}-${index + 1}.png`,
      }))
      : []
  )), [rounds]);
  const lightboxIndex = lightboxSrc ? lightboxItems.findIndex((item) => item.src === lightboxSrc) : -1;
  const [mountedHistoryCount, setMountedHistoryCount] = useState(HISTORY_BATCH_SIZE);
  const [historyAutoLoadArmed, setHistoryAutoLoadArmed] = useState(() => !focusJobId);
  const historySentinelRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const roundsLengthRef = useRef(rounds.length);
  roundsLengthRef.current = rounds.length;
  const newestWindow = rounds.slice(-mountedHistoryCount);
  const focusedRound = focusJobId
    ? rounds.find((round) => round.kind === 'agent' ? round.jobs.some(job => job.job_id === focusJobId) : round.jobId === focusJobId)
    : undefined;
  const mountedRounds = focusedRound && !newestWindow.includes(focusedRound)
    ? [focusedRound, ...newestWindow]
    : newestWindow;
  const remainingCount = Math.max(0, rounds.length - mountedHistoryCount);
  const hasEarlierHistory = remainingCount > 0;
  useEffect(() => setHistoryAutoLoadArmed(!focusJobId), [focusJobId]);
  // 入场只给新到达的那一轮：排在已挂载记录之后、之前没见过的 key。首屏、往上加载的历史、
  // 深链置顶的记录都在已知记录之前或没有已知记录，不动。
  const mountedKeys = mountedRounds.map(roundKey);
  const knownKeys = useRef<Set<string> | null>(null);
  const known = knownKeys.current;
  let lastKnownIndex = -1;
  if (known) mountedKeys.forEach((key, index) => { if (known.has(key)) lastKnownIndex = index; });
  const enteringKeys = new Set(known && lastKnownIndex >= 0
    ? mountedKeys.slice(lastKnownIndex + 1).filter(key => !known.has(key))
    : []);
  useEffect(() => {
    const next = knownKeys.current ?? new Set<string>();
    for (const key of mountedKeys) next.add(key);
    knownKeys.current = next;
  });
  // 出现过「生成中」的轮次：完成时结果卡垫上占位交接层，结果在它上面淡入；历史记录直接显示。
  const seenPendingKeys = useRef(new Set<string>());
  useEffect(() => {
    for (const round of rounds) if (round.kind === 'pending') seenPendingKeys.current.add(roundKey(round));
  }, [rounds]);
  const [leavingKeys, removeAfterFade] = useLeavingRounds();
  // 前后各一张先预取，翻页时新图多半已在缓存里，不经过空白。
  const lightboxNeighbours = useMemo(() => (lightboxIndex < 0 ? [] : [
    lightboxItems[lightboxIndex - 1]?.src,
    lightboxItems[lightboxIndex + 1]?.src,
  ].filter((src): src is string => Boolean(src))), [lightboxItems, lightboxIndex]);
  // 不循环：到头的一侧不给回调，大图层据此把那一侧箭头置灰。
  const lightboxStep = (offset: -1 | 1) => {
    const target = lightboxIndex < 0 ? undefined : lightboxItems[lightboxIndex + offset];
    return target ? () => setLightboxSrc(target.src) : undefined;
  };
  useEffect(() => {
    const sentinel = historySentinelRef.current;
    if (historyAutoLoadArmed || !hasEarlierHistory || !sentinel) return;
    const root = sentinel.closest('[data-studio-history-scroll]');
    if (!root) return;
    const armFromWheel = (event: Event) => {
      if ((event as WheelEvent).deltaY < 0) setHistoryAutoLoadArmed(true);
    };
    const captureTouchStart = (event: Event) => {
      const touch = (event as TouchEvent).touches[0];
      touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const armFromTouch = (event: Event) => {
      const start = touchStartRef.current;
      const touch = (event as TouchEvent).touches[0];
      if (!start || !touch) return;
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      // 历史在视口上方：手指向下拖才是向更早记录滚动。横向/反向轻扫不武装。
      if (deltaY > 8 && deltaY > Math.abs(deltaX)) setHistoryAutoLoadArmed(true);
    };
    const armFromKey = (event: Event) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes((event as KeyboardEvent).key)) {
        setHistoryAutoLoadArmed(true);
      }
    };
    root.addEventListener('wheel', armFromWheel, { passive: true });
    root.addEventListener('touchstart', captureTouchStart, { passive: true });
    root.addEventListener('touchmove', armFromTouch, { passive: true });
    root.addEventListener('keydown', armFromKey);
    return () => {
      root.removeEventListener('wheel', armFromWheel);
      root.removeEventListener('touchstart', captureTouchStart);
      root.removeEventListener('touchmove', armFromTouch);
      root.removeEventListener('keydown', armFromKey);
    };
  }, [hasEarlierHistory, historyAutoLoadArmed]);
  // 复刻成熟无限列表的 loader-row 模式：顶部哨兵进入预加载区时再追加一页。
  // 观察器不随每批重建，一次进入只触发一次，避免哨兵停留时连续挂载全部历史。
  useEffect(() => {
    const sentinel = historySentinelRef.current;
    if (
      !historyAutoLoadArmed
      || !hasEarlierHistory
      || !sentinel
      || typeof IntersectionObserver === 'undefined'
    ) return;
    const root = sentinel.closest('[data-studio-history-scroll]');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setMountedHistoryCount((count) => Math.min(
          count + HISTORY_BATCH_SIZE,
          roundsLengthRef.current,
        ));
      },
      { root, rootMargin: HISTORY_LOAD_ROOT_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasEarlierHistory, historyAutoLoadArmed]);
  const renderMedia = (r: RoundState, mediaActive: boolean) => {
    const key = roundKey(r);
    // 嵌在 Agent 回合里的结果没有单独的外层，删除不做整轮淡出。
    const fadeThen = <A extends unknown[]>(remove?: (...args: A) => void | Promise<void>) => (
      remove && !embedded ? (...args: A) => removeAfterFade(key, () => remove(...args)) : remove
    );
    return (
    <>
    {r.kind === 'pending' && (
      <PendingBatch
        round={r}
        embedded={embedded}
        showActions={!embedded || rounds.length === 1}
        onCancel={onCancel}
        onReEdit={onReEdit}
        reuseParameter={reuseParameter}
        onRegenerate={onRegenerate}
        onReuseReferences={onReuseReferences}
        mediaActive={mediaActive}
      />
    )}
    {r.kind === 'done' && (
      <DoneBatch
        round={r}
        embedded={embedded}
        showActions={!embedded || rounds.length === 1}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        hiddenPaths={hiddenPaths}
        onToggleHidden={onToggleHidden}
        onReEdit={onReEdit}
        reuseParameter={reuseParameter}
        onRegenerate={onRegenerate}
        onDeleteBatch={fadeThen(onDeleteBatch)}
        onLightbox={setLightboxSrc}
        justCompleted={seenPendingKeys.current.has(key)}
        onReuseReferences={onReuseReferences}
        onEditAsReference={onEditAsReference}
        onSavePromptAsset={onSavePromptAsset}
        onSaveResultAsset={onSaveResultAsset}
        onShareResult={onShareResult}
        onSetPromptPreview={onSetPromptPreview}
        mediaActive={mediaActive}
      />
    )}
    {r.kind === 'failed' && (
      <FailedCard
        round={r}
        embedded={embedded}
        showActions={!embedded || rounds.length === 1}
        onDeleteFailed={fadeThen(onDeleteFailed)}
        onReEdit={onReEdit}
        reuseParameter={reuseParameter}
        onRegenerate={onRegenerate}
        onReuseReferences={onReuseReferences}
        mediaActive={mediaActive}
      />
    )}
    </>
    );
  };
  if (rounds.length === 0) return null;
  return (
    <>
      <div
        data-testid="studio-round-list"
        className={embedded ? "w-full text-left" : "mx-auto mt-8 w-full min-w-0 max-w-[1024px] space-y-8 text-left"}
      >
        {hasEarlierHistory && (
          <div
            ref={historySentinelRef}
            data-testid="history-load-sentinel"
            aria-hidden="true"
            className="h-px w-full"
          />
        )}
        {embedded ? <MediaActivationBoundary>
          {active => <div className={ROUND_MEDIA_CLASS}>{rounds.map(r => r.kind !== 'agent' && (
            <Fragment key={roundKey(r)}>{renderMedia(r, active)}</Fragment>
          ))}</div>}
        </MediaActivationBoundary> : mountedRounds.map((r, index) => {
          const date = roundDate(r);
          const startsDate = index === 0 || roundDate(mountedRounds[index - 1]) !== date;
          const stableKey = mountedKeys[index];
          return (
            // data-round-job：首页作品深链（/studio?job=）滚动定位的锚点。
            <Fragment key={stableKey}>
            {/* 列表的 space-y-8 给每个子项加 2rem 下边距；组标题收成 0.75rem，贴近它带起的第一条记录 */}
            {!embedded && startsDate && <h3 data-testid="round-date" className="mb-3 text-xs tabular-nums text-muted-foreground">{date}</h3>}
            <RoundEnter enter={enteringKeys.has(stableKey)} leaving={leavingKeys.has(stableKey)}>
              <div className={r === focusedRound
                ? `rounded-xl outline-2 outline-offset-8 transition-[outline-color] ${focusHighlight ? 'outline-primary duration-300 ease-out' : 'outline-transparent duration-150'}`
                : undefined}>
              {r.kind === 'agent' ? renderAgent?.(r) : <MediaActivationBoundary jobId={r.jobId}>
                {(mediaActive) => (
                  renderMedia(r, mediaActive)
                )}
              </MediaActivationBoundary>}
              </div>
            </RoundEnter>
            </Fragment>
          );
        })}
      </div>
      {lightboxSrc && (
        <Lightbox
          src={lightboxSrc}
          onClose={() => setLightboxSrc(null)}
          onPrevious={lightboxStep(-1)}
          onNext={lightboxStep(1)}
          preloadSrcs={lightboxNeighbours}
          downloadName={lightboxItems[lightboxIndex]?.name}
          details={embedded && lightboxItems[lightboxIndex] && <>
            <p>{lightboxItems[lightboxIndex].config.prompt}</p>
            <SpecChips config={lightboxItems[lightboxIndex].config} />
          </>}
        />
      )}
    </>
  );
}

function PendingBatch({
  round, embedded, showActions,
  onCancel,
  onReEdit,
  reuseParameter,
  onRegenerate,
  onReuseReferences,
  mediaActive,
}: {
  embedded: boolean;
  showActions: boolean;
  round: Extract<RoundState, { kind: 'pending' }>;
  onCancel?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  reuseParameter?: ParameterReuse;
  onRegenerate?: (config: RoundConfig, failedJobId?: string) => void | Promise<void>;
  onReuseReferences?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  mediaActive: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const shownMjFlags = shownMjMetadata(round.config);
  const elapsedSec = Math.max(0, Math.floor((now - round.startedAt) / 1000));
  const submittedAt = formatBeijingTime(new Date(round.startedAt).toISOString()).slice(11);

  const cancel = round.jobId && onCancel && (
    <ActionButton
      data-testid="studio-cancel-round"
      disabled={round.cancelRequested}
      onClick={() => { void onCancel(round.jobId!); }}
    >
      <StopIcon size="sm" className="mr-1.5 fill-current" aria-hidden />
      <SwapLabel active={Boolean(round.cancelRequested)} on="停止中…" off="停止" />
    </ActionButton>
  );
  const isVideo = round.config.kind === 'video';
  const expectedMs = expectedDurationMs(round.config.kind, round.config.duration);
  // 等待区只留一套信息：中央转圈 + 底部渐近细条 + 阶段角标；耗时只在操作行显示一处。
  return (
      <section className={embedded ? "contents" : ROUND_SECTION_CLASS}>
        {!embedded && <div className={ROUND_HEADER_CLASS}>
          <div className={ROUND_PROMPT_ROW_CLASS}>
            <ReferenceStack
              config={round.config}
              jobId={round.jobId}
              onReuse={onReuseReferences}
              mediaActive={mediaActive}
            />
            <div className="min-w-0 flex-1">
              <MentionPrompt
                prompt={round.config.prompt}
                config={round.config}
                jobId={round.jobId}
                mediaActive={mediaActive}
                onUsePrompt={onReEdit ? () => { void onReEdit(round.config, round.jobId); } : undefined}
              />
            </div>
          </div>
          <SpecChips testId="pending-spec-meta" config={round.config} reuseParameter={reuseParameter}>
            {round.config.sourceAssetTitle && <SourceChip title={round.config.sourceAssetTitle} />}
            {shownMjFlags && (
              <span className="basis-full break-words font-mono text-muted-foreground">{shownMjFlags}</span>
            )}
          </SpecChips>
        </div>}
        <div className={embedded ? "contents" : ROUND_MEDIA_CLASS}>
          {Array.from({ length: Math.max(1, round.config.n ?? 1) }, (_, i) => (
            <div
              key={i}
              data-round-job={embedded && i === 0 ? round.jobId : undefined}
              data-testid={i === 0 && round.jobId ? `studio-pending-${round.jobId}` : undefined}
              data-skeleton
              aria-busy="true"
              style={aspectStyle(round.config)}
              className="relative flex w-[251.5px] items-center justify-center overflow-hidden rounded-lg bg-card/40"
            >
              {i === 0 && !showActions && cancel && <div className="absolute bottom-2 right-2">{cancel}</div>}
              <span
                data-testid="progress-badge"
                className="absolute left-2 top-2 rounded-full bg-scrim px-2.5 py-1 text-xs text-white"
              >
                {stageLabel(round.progressPhase, isVideo)}
              </span>
              <div className={ROUND_SPINNER_CLASS} />
              <ProgressLine
                progressKey={roundKey(round)}
                startedAt={round.startedAt}
                expectedMs={expectedMs}
                phase={round.progressPhase}
                held={isVideo && !round.progressPhase}
              />
            </div>
          ))}
        </div>
        {showActions && <div className={ROUND_ACTIONS_CLASS + (embedded ? " basis-full" : "")}>
          <ActionButton onClick={() => { void onReEdit?.(round.config, round.jobId); }}>重新编辑</ActionButton>
          <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
          {cancel}
          <Hint label="耗时 · 提交时间"><p data-testid="pending-run-meta" className={ROUND_RUN_META_CLASS}>
            {elapsedSec}s · {submittedAt}
          </p></Hint>
        </div>}
      </section>
  );
}

function MediaActivationBoundary({
  jobId,
  children,
}: {
  jobId?: string;
  children: (mediaActive: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mediaActive, setMediaActive] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setMediaActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setMediaActive(entry.isIntersecting),
      { rootMargin: MEDIA_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} data-round-job={jobId ?? undefined}>
      {children(mediaActive)}
    </div>
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
function refImageSrc(path: string, jobId?: string) {
  if (path.startsWith('http')) return path;
  if (jobId) return `/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`;
  if (/^(characters|studio)\//.test(path)) {
    return `/api/gallery/image?path=${encodeURIComponent(path)}`;
  }
  return `/api/raw?path=${encodeURIComponent(path)}`;
}

// 历史参考堆叠合并三类素材（视频 round 常只有视频/音频参考，单看图片会整组消失）。
function allRefs(config: RoundConfig): string[] {
  return [
    ...config.referenceImages,
    ...(config.mjRefPaths?.sref ?? []),
    ...(config.mjRefPaths?.cref ?? []),
    ...(config.mjRefPaths?.oref ?? []),
    ...(config.referenceVideos ?? []),
    ...(config.referenceAudios ?? []),
  ];
}

const MJ_REFERENCE_FLAGS = new Set(['--sref', '--cref', '--oref']);
const MJ_REFERENCE_WEIGHT_FLAGS = new Set(['--sw', '--cw', '--ow']);

/** 参考图与权重已经由左侧缩略图表达，参数行只保留其余实际生效的 MJ 控制。 */
function visibleMjFlags(flags?: string): string {
  const tokens = flags?.trim().split(/\s+/).filter(Boolean) ?? [];
  const visible: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (MJ_REFERENCE_FLAGS.has(token)) {
      index += 1;
      while (index < tokens.length && !tokens[index].startsWith('--')) index += 1;
      continue;
    }
    if (MJ_REFERENCE_WEIGHT_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    visible.push(token);
    index += 1;
  }
  return visible.join(' ');
}

const REF_CARD_W = 46;
const REF_CARD_H = 58;
const REF_ROTATIONS = [-6, 5, -4, 7, -5, 4, -3, 6];
const REF_OVERLAP_REST = 30;
const REF_OVERLAP_HOVER = 8;
/** 悬停放大与图片卡片统一 1.02：散开已经交代了「可以看」，当前那张只靠微放大和提到最上层区分。 */
const HOVER_SCALE = 1.02;

// 出图历史里提示词左侧的参考图堆叠：未 hover 重叠旋转成一叠；hover 时整组散开、每张以中心为轴放大；点击看大图（或整组复用）。
function ReferenceStack({
  config,
  jobId,
  onReuse,
  mediaActive,
}: {
  config: RoundConfig;
  jobId?: string;
  onReuse?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  mediaActive: boolean;
}) {
  const refs = allRefs(config);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (refs.length === 0) return null;
  const activeSrc = refs[active ?? 0];
  const canPreview = activeSrc && isImagePath(activeSrc);
  return (
    <>
      <div className="relative shrink-0">
        <Hint label={canPreview ? '点击查看参考大图' : '点击复用这组参考素材'}><Button variant="bare"
          type="button"
          data-testid="reference-stack"
          aria-label="复用这组参考素材"
          onClick={() => {
            if (canPreview && !onReuse) {
              setLightboxSrc(refImageSrc(activeSrc, jobId));
              return;
            }
            if (onReuse) void onReuse(config, jobId);
            else if (canPreview) setLightboxSrc(refImageSrc(activeSrc, jobId));
          }}
          onDoubleClick={() => {
            if (canPreview) setLightboxSrc(refImageSrc(activeSrc, jobId));
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => { setHover(false); setActive(null); }}
          style={{
            width: REF_CARD_W + Math.max(0, refs.length - 1) * (REF_CARD_W - REF_OVERLAP_REST),
            height: REF_CARD_H,
          }}
          className="group relative z-20 flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0"
        >
          {refs.map((src, i) => {
            const angle = REF_ROTATIONS[i % REF_ROTATIONS.length];
            const isActive = active === i;
            const scale = isActive ? HOVER_SCALE : 1;
            return (
              <span
                key={i}
                onMouseEnter={() => setActive(i)}
                onClick={e => {
                  if (isImagePath(src) && e.detail === 1 && !onReuse) {
                    e.stopPropagation();
                    setLightboxSrc(refImageSrc(src, jobId));
                  }
                }}
                style={{
                  width: REF_CARD_W,
                  height: REF_CARD_H,
                  left: 0,
                  top: 0,
                  zIndex: isActive ? 30 : i,
                  transform: `translateX(${i * (REF_CARD_W - (hover ? REF_OVERLAP_HOVER : REF_OVERLAP_REST))}px) rotate(${angle}deg) scale(${scale})`,
                  transformOrigin: 'center',
                }}
                className="absolute block overflow-hidden rounded-lg border-[1.5px] border-white bg-card transition-transform duration-200 ease-in-out"
              >
                <RefThumb src={src} jobId={jobId} mediaActive={mediaActive} />
              </span>
            );
          })}
        </Button></Hint>
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

// ---- 提示词 @引用只读 chip（与输入框 PromptInput 的 chip 同款视觉）----

// 提交链路会把 @视频1 序列化成 视频1（厂商契约要的形态），job 里存的是序列化后的
// prompt —— 所以这里 @ 可选；误伤靠「只有对应参考素材真实存在才 chip 化」兜底。
function mentionRefPath(config: RoundConfig, kind: MentionKind, n: number): string | null {
  const list = kind === 'image' ? config.referenceImages
    : kind === 'video' ? config.referenceVideos
    : config.referenceAudios;
  return list?.[n - 1] ?? null;
}

type MentionHover = { kind: MentionKind; path: string; left: number; top: number };

const PROMPT_HOVER_INTENT_MS = 200;
const PROMPT_OVERLAY_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle },
} as const;

/** 历史记录里的提示词：@图片N/@图N/@视频N/@音频N 渲染成同款 chip；悬停时零位移浮现外框（长文本展开全文，短文本浮现「使用提示词」）。 */
function MentionPrompt({
  prompt,
  config,
  jobId,
  mediaActive,
  onUsePrompt,
}: {
  prompt: string;
  config: RoundConfig;
  jobId?: string;
  mediaActive: boolean;
  onUsePrompt?: () => void;
}) {
  const [hover, setHover] = useState<MentionHover | null>(null);
  const [expandedOpen, setExpandedOpen] = useState(false);
  // 意图延迟：鼠标扫过记录列表时不让浮层一路闪；停留 200ms 才浮现。
  const intentTimer = useRef<number | null>(null);
  const clearIntent = () => {
    if (intentTimer.current !== null) window.clearTimeout(intentTimer.current);
    intentTimer.current = null;
  };
  useEffect(() => clearIntent, []);
  const isLongPrompt = prompt.length > 48 || prompt.includes('\n');
  const parts = useMemo(() => {
    const out: Array<string | { label: string; kind: MentionKind; path: string }> = [];
    let last = 0;
    for (const m of prompt.matchAll(createMentionTokenRegex(true))) {
      // 引用的素材不存在 → 当普通文本，不 chip 化（防止正文里碰巧出现"视频1"被误伤）。
      const kind = mentionKindFromToken(m[1]);
      const path = mentionRefPath(config, kind, parseInt(m[2], 10));
      if (!path) continue;
      if (m.index! > last) out.push(prompt.slice(last, m.index));
      out.push({ label: canonicalMentionLabel(m[1], m[2]), kind, path });
      last = m.index! + m[0].length;
    }
    if (last < prompt.length) out.push(prompt.slice(last));
    return out;
  }, [prompt, config]);

  const renderParts = () =>
    parts.map((part, i) =>
      typeof part === 'string' ? (
        <span key={i}>{part}</span>
      ) : (
        <MentionChip
          key={i}
          label={part.label}
          kind={part.kind}
          path={part.path}
          jobId={jobId}
          onHover={setHover}
          mediaActive={mediaActive}
        />
      ),
    );

  return (
    <>
      <div
        data-testid="round-prompt-container"
        className="relative"
        onMouseEnter={() => {
          clearIntent();
          intentTimer.current = window.setTimeout(() => setExpandedOpen(true), PROMPT_HOVER_INTENT_MS);
        }}
        onMouseLeave={() => {
          clearIntent();
          setExpandedOpen(false);
        }}
      >
        <p className="line-clamp-2 text-sm leading-6 text-foreground">
          {renderParts()}
        </p>
        {/* 原位浮现外框，零位移，只淡入淡出（150ms）。 */}
        <AnimatePresence>
        {expandedOpen && (
          isLongPrompt ? (
            <motion.div
              key="long"
              {...PROMPT_OVERLAY_FADE}
              data-testid="round-prompt-expanded"
              className="shell-glow absolute -left-[13px] -right-[13px] -top-[9px] z-40 rounded-xl border border-border bg-popover px-3 py-2 text-sm leading-6 text-foreground"
            >
              <p className="whitespace-pre-wrap break-words">
                {renderParts()}
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="short"
              {...PROMPT_OVERLAY_FADE}
              data-testid="round-prompt-expanded"
              className="shell-glow absolute -left-[13px] -top-[7px] z-40 inline-flex max-w-full items-center gap-3 rounded-xl border border-border bg-popover px-3 py-1.5 text-sm leading-6 text-foreground"
            >
              <p className="whitespace-pre-wrap break-words">
                {renderParts()}
              </p>
              {onUsePrompt && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  data-testid="round-use-prompt"
                  onClick={onUsePrompt}
                  className="h-6 shrink-0 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <TextIcon size="sm" aria-hidden />
                  使用提示词
                </Button>
              )}
            </motion.div>
          )
        )}
        </AnimatePresence>
      </div>
      {hover && createPortal(
        <div
          data-testid="round-mention-preview"
          className="fixed z-50 pointer-events-none"
          style={{ left: hover.left, top: hover.top - 8, transform: 'translate(-50%, -100%)' }}
        >
          {hover.kind === 'video' ? (
            <video
              src={refImageSrc(hover.path, jobId)}
              autoPlay
              muted
              loop
              playsInline
              className="h-[150px] rounded-lg border border-border bg-card"
            />
          ) : hover.kind === 'image' ? (
            <img
              src={refImageSrc(hover.path, jobId)}
              alt=""
              className="h-[150px] rounded-lg border border-border bg-card object-contain"
            />
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              <AudioIcon aria-hidden />
              <span className="max-w-[180px] truncate">{hover.path.split('/').pop()}</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function MentionChip({ label, kind, path, jobId, onHover, mediaActive }: {
  label: string;
  kind: MentionKind;
  path: string;
  jobId?: string;
  onHover: (h: MentionHover | null) => void;
  mediaActive: boolean;
}) {
  const frame = useVideoFrame(kind === 'video' ? refImageSrc(path, jobId) : null, mediaActive);
  const thumb = kind === 'image' ? refImageSrc(path, jobId) : frame;
  return (
    <span
      data-mention={label}
      className="inline-flex items-center gap-1 align-middle text-primary"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onHover({ kind, path, left: r.left + r.width / 2, top: r.top });
      }}
      onMouseLeave={() => onHover(null)}
    >
      {thumb ? (
        <img src={thumb} alt="" draggable={false} className="pointer-events-none h-[18px] w-[18px] select-none rounded-sm object-cover" />
      ) : kind !== 'image' ? (
        <span className="grid h-[18px] w-[18px] select-none place-items-center rounded-sm bg-secondary text-muted-foreground">
          {kind === 'video' ? <VideoIcon size="sm" aria-hidden /> : <AudioIcon size="sm" aria-hidden />}
        </span>
      ) : null}
      <span>{label}</span>
    </span>
  );
}

// 堆叠卡内容：图片直出、视频抽首帧（失败退回 Film 图标）、音频固定 Music 图标。
function RefThumb({ src, jobId, mediaActive }: { src: string; jobId?: string; mediaActive: boolean }) {
  const isImage = isImagePath(src);
  const isAudio = !isImage && isAudioPath(src);
  const frame = useVideoFrame(
    !isImage && !isAudio ? refImageSrc(src, jobId) : null,
    mediaActive,
  );
  const thumb = isImage ? refImageSrc(src, jobId) : frame;
  if (thumb) {
    return <img src={thumb} alt="参考素材" className="h-full w-full object-cover" draggable={false} />;
  }
  return (
    <span className="flex h-full w-full items-center justify-center bg-card text-muted-foreground">
      {isAudio ? <AudioIcon /> : <VideoIcon />}
    </span>
  );
}

type ShareResultHandler = (jobId: string, index: number, path: string, config: RoundConfig) => void;

// 结果图上的悬停按钮用不透明底，不叠毛玻璃：每张图好几颗 backdrop-blur 在长列表里很贵。
const RESULT_BUTTON_BASE = 'grid size-8 place-items-center rounded-full border border-border bg-scrim transition-opacity duration-150 hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
/** 悬停浮现；触屏没有悬停，常驻显示（按钮本身 32px，热区够大）。 */
const RESULT_REVEAL = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';
const RESULT_ACTION_CLASS = `${RESULT_BUTTON_BASE} text-white ${RESULT_REVEAL}`;
/** 喜欢、隐藏这类开关：打开时常驻显示，关着时随悬停浮现。 */
function resultToggleClass(on: boolean) {
  return `${RESULT_BUTTON_BASE} ${on ? 'text-primary opacity-100' : `text-white ${RESULT_REVEAL}`}`;
}

/** 保存一张生成结果。index 是 imagePaths 下标（= Job.output_paths 下标）；
 *  generated = Studio 自家出图（job.namespace === 'studio'），只有它能存成带配方的生成资产。 */
export interface SaveResultAssetRequest {
  jobId: string;
  index: number;
  path: string;
  mediaKind: 'image' | 'video';
  generated: boolean;
  config: RoundConfig;
}

type SaveResultAssetHandler = (request: SaveResultAssetRequest) => void;

function SaveResultButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Hint label="保存为创作资产"><Button variant="bare"
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className={RESULT_ACTION_CLASS}
    >
      <SaveAssetIcon aria-hidden />
    </Button></Hint>
  );
}

function ShareResultButton({ index, onClick }: { index: number; onClick: () => void }) {
  return (
    <Hint label="分享到团队库"><Button variant="bare"
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`分享生成结果 ${index + 1}`}
      className={RESULT_ACTION_CLASS}
    >
      <ShareIcon aria-hidden />
    </Button></Hint>
  );
}

function DoneBatch({
  round, embedded, showActions,
  favorites,
  onToggleFavorite,
  hiddenPaths,
  onToggleHidden,
  onReEdit,
  reuseParameter,
  onRegenerate,
  onDeleteBatch,
  onLightbox,
  onReuseReferences,
  onEditAsReference,
  onSavePromptAsset,
  onSaveResultAsset,
  onShareResult,
  onSetPromptPreview,
  mediaActive,
  justCompleted,
}: {
  embedded: boolean;
  showActions: boolean;
  round: Extract<RoundState, { kind: 'done' }>;
  /** 这一轮刚从「生成中」变成完成：结果在占位交接层上淡入。 */
  justCompleted: boolean;
  favorites?: string[];
  onToggleFavorite?: (path: string) => void | Promise<void>;
  hiddenPaths?: string[];
  onToggleHidden?: (path: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  reuseParameter?: ParameterReuse;
  onRegenerate?: (config: RoundConfig, failedJobId?: string) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onLightbox?: (src: string) => void;
  onReuseReferences?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  onEditAsReference?: (path: string) => void | Promise<void>;
  onSavePromptAsset?: (config: RoundConfig) => void;
  onSaveResultAsset?: SaveResultAssetHandler;
  onShareResult?: ShareResultHandler;
  onSetPromptPreview?: (request: PromptPreviewRequest) => void;
  mediaActive: boolean;
}) {
  const elapsedSec =
    round.completedAt && round.submittedAt
      ? Math.max(0, Math.round((Date.parse(round.completedAt) - Date.parse(round.submittedAt)) / 1000))
      : null;
  // 两行分层：出图参数（模型/尺寸/比例/清晰度/张数）是主元信息；耗时 + 生成时间是运行信息，
  // 降到更小更淡的次行，别和参数挤在一行。
  // 日期由分组标题承担，这里只留时分。
  const runMeta = [
    elapsedSec != null ? `${elapsedSec}s` : undefined,
    round.completedAt ? formatBeijingTime(round.completedAt).slice(11) : undefined,
  ].filter(Boolean);
  const shownMjFlags = shownMjMetadata(round.config);
  const share = round.shareable ? onShareResult : undefined;
  const saveResult = onSaveResultAsset
    ? (index: number, path: string, mediaKind: 'image' | 'video') => onSaveResultAsset({
        jobId: round.jobId,
        index,
        path,
        mediaKind,
        generated: round.shareable === true,
        config: round.config,
      })
    : undefined;
  const startedAt = Date.parse(round.submittedAt);

  return (
    <section className={embedded ? "contents" : ROUND_SECTION_CLASS}>
      {!embedded && <div className={ROUND_HEADER_CLASS}>
        <div className={ROUND_PROMPT_ROW_CLASS}>
          <ReferenceStack
            config={round.config}
            jobId={round.jobId}
            onReuse={onReuseReferences}
            mediaActive={mediaActive}
          />
          <div className="min-w-0 flex-1">
            <MentionPrompt
              prompt={round.config.prompt}
              config={round.config}
              jobId={round.jobId}
              mediaActive={mediaActive}
              onUsePrompt={onReEdit ? () => { void onReEdit(round.config, round.jobId); } : undefined}
            />
          </div>
        </div>
        <div>
          <SpecChips testId="round-spec-meta" config={round.config} reuseParameter={reuseParameter}>
            {round.config.sourceAssetTitle && <SourceChip testId="round-asset-source" title={round.config.sourceAssetTitle} />}
            {shownMjFlags && (
              <span data-testid="round-mj-flags" className="basis-full break-words font-mono text-muted-foreground">
                {shownMjFlags}
              </span>
            )}
          </SpecChips>
          {/* 后端回写的静默改写提示（尺寸归一化 / 参考图截断）——是提示不是错误，走 muted 灰不用暖红。 */}
          {(round.config.warnings?.length ?? 0) > 0 && (
            <ul data-testid="round-warnings" className="mt-1.5 space-y-1">
              {round.config.warnings!.map((warning, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <InfoIcon size="sm" className="mt-px shrink-0" aria-hidden />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>}
      <div className={embedded ? "contents" : ROUND_MEDIA_CLASS}>
        {round.config.kind === 'video'
          ? round.imagePaths.map((path, index) => {
              const favorited = !!favorites && isGalleryFavorited(path, favorites);
              return (
                <ResultFrame
                  key={path}
                  config={round.config}
                  justCompleted={justCompleted}
                  startedAt={startedAt}
                  progressKey={roundKey(round)}
                  roundJob={embedded && index === 0 ? round.jobId : undefined}
                  testId={`studio-result-video-${index + 1}`}
                  className="group relative w-[251.5px] max-w-full overflow-hidden rounded-lg border border-border bg-card"
                  // 封面（图标占位）垫在底下，视频首帧可显示后在它上面淡入，换上去的过程不露黑帧也不露空白。
                  media={({ onSize, onReady }) => <>
                    <div
                      data-testid={mediaActive ? undefined : 'studio-video-placeholder'}
                      aria-hidden={mediaActive}
                      className="absolute inset-0 flex items-center justify-center text-muted-foreground"
                    >
                      <VideoIcon size="xl" aria-hidden />
                    </div>
                    {mediaActive && <ResultVideo src={videoSrc(path)} onSize={onSize} onReady={onReady} />}
                  </>}
                >
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    {share && (
                      <ShareResultButton index={index} onClick={() => share(round.jobId, index, path, round.config)} />
                    )}
                    {saveResult && (
                      <SaveResultButton
                        label={`保存生成视频 ${index + 1} 为资产`}
                        onClick={() => saveResult(index, path, 'video')}
                      />
                    )}

                    <Hint label={favorited ? '取消喜欢' : '喜欢'}><Button variant="bare"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void onToggleFavorite?.(path); }}
                      aria-label={favorited ? '取消喜欢' : '喜欢'}
                      className={resultToggleClass(favorited)}
                    >
                      <SwapIcon swapKey={favorited} variant="pop"><FavoriteIcon className={favorited ? 'fill-current' : ''} aria-hidden /></SwapIcon>
                    </Button></Hint>
                    <Hint label="下载视频"><a
                      href={videoSrc(path)}
                      download={path.split('/').pop() || `${round.jobId}-${index + 1}.mp4`}
                      aria-label={`下载生成视频 ${index + 1}`}
                      className={RESULT_ACTION_CLASS}
                    >
                      <DownloadIcon aria-hidden />
                    </a></Hint>
                  </div>
                </ResultFrame>
              );
            })
          : round.imagePaths.map((path, index) => {
              const favorited = !!favorites && isGalleryFavorited(path, favorites);
              const hidden = !!hiddenPaths && isGalleryHidden(path, hiddenPaths);
              return (
                <ResultFrame
                  key={path}
                  config={round.config}
                  justCompleted={justCompleted}
                  startedAt={startedAt}
                  progressKey={roundKey(round)}
                  roundJob={embedded && index === 0 ? round.jobId : undefined}
                  testId={`studio-result-thumb-${index + 1}`}
                  className="media-edge group w-[251.5px] overflow-hidden rounded-md bg-card cursor-pointer"
                  onClick={() => onLightbox?.(imageSrc(path))}
                  media={({ onSize, onReady }) => (
                    <RevealImage
                      src={imageSrc(path)}
                      alt={`生成结果 ${index + 1}`}
                      loading="lazy"
                      decoding="async"
                      onLoad={event => onSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
                      onReady={onReady}
                      className="media-checker relative h-full w-full object-contain"
                    />
                  )}
                >
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    {(share || saveResult || onSetPromptPreview) && <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="secondary" size="icon"
                        aria-label={`生成结果 ${index + 1} 的更多操作`}
                        className={`size-8 rounded-full bg-scrim text-white transition-opacity duration-150 ${RESULT_REVEAL}`}
                        onClick={event => event.stopPropagation()}><MoreIcon /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
                        {onSetPromptPreview && <DropdownMenuItem onSelect={() => onSetPromptPreview({ jobId: round.jobId, outputIndex: index, promptAssetId: round.config.promptAssetId })}><AddImageIcon />设为效果图</DropdownMenuItem>}
                        {saveResult && <DropdownMenuItem aria-label={`保存生成结果 ${index + 1} 为资产`} onSelect={() => saveResult(index, path, 'image')}><SaveAssetIcon />保存为创作资产</DropdownMenuItem>}
                        {share && <DropdownMenuItem aria-label={`分享生成结果 ${index + 1}`} onSelect={() => share(round.jobId, index, path, round.config)}><ShareIcon />分享到团队库</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>}

                    <Hint label={favorited ? '取消喜欢' : '喜欢'}><Button variant="bare"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void onToggleFavorite?.(path); }}
                      aria-label={favorited ? '取消喜欢' : '喜欢'}
                      className={resultToggleClass(favorited)}
                    >
                      <SwapIcon swapKey={favorited} variant="pop"><FavoriteIcon className={favorited ? 'fill-current' : ''} aria-hidden /></SwapIcon>
                    </Button></Hint>
                    {onToggleHidden && (
                      <Hint label={hidden ? '取消隐藏' : '隐藏（不在首页展示）'}><Button variant="bare"
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void onToggleHidden(path); }}
                        aria-label={hidden ? '取消隐藏' : '隐藏（不在首页展示）'}
                        className={resultToggleClass(hidden)}
                      >
                        <SwapIcon swapKey={Boolean(hidden)}>{hidden ? <HideIcon aria-hidden /> : <ShowIcon aria-hidden />}</SwapIcon>
                      </Button></Hint>
                    )}
                    <Hint label="下载图片"><a
                      href={imageSrc(path)}
                      download={path.split('/').pop() || `${round.jobId}-${index + 1}.png`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`下载生成结果 ${index + 1}`}
                      className={RESULT_ACTION_CLASS}
                    >
                      <DownloadIcon aria-hidden />
                    </a></Hint>
                  </div>
                  {/* 左下角编辑：把这张图导入下方输入框作参考图，继续图生图微调。 */}
                  {onEditAsReference && (
                    <Hint label="编辑（导入为参考图）"><Button variant="bare"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void onEditAsReference(path); }}
                      aria-label={`编辑生成结果 ${index + 1}（导入为参考图）`}
                      className={`absolute bottom-2 left-2 ${RESULT_ACTION_CLASS}`}
                    >
                      <EditIcon aria-hidden />
                    </Button></Hint>
                  )}
                </ResultFrame>
              );
            })}
      </div>
      {showActions && <div className={ROUND_ACTIONS_CLASS + (embedded ? " basis-full" : "")}>
        <ActionButton onClick={() => { void onReEdit?.(round.config, round.jobId); }}>重新编辑</ActionButton>
        <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
        {/* skill 出图（角色立绘/KV/三视图）在出图页只作溯源展示——删除会从磁盘抹掉角色资产，
            该操作只留在工坊页。这里仅对 studio 自家出图开放「删除该批次结果」。 */}
        {(onSavePromptAsset || round.shareable !== false) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ActionButton compact aria-label="更多操作">...</ActionButton>
          </DropdownMenuTrigger>
          {/* 空间不够时 Radix 自动翻到左侧，不再按断点手动改方向 */}
          <DropdownMenuContent data-testid="studio-more-menu" side="right" align="start" className="w-48 rounded-xl">
            {onSavePromptAsset && (
              <DropdownMenuItem onSelect={() => onSavePromptAsset(round.config)}>
                <SaveAssetIcon className="shrink-0" aria-hidden />
                保存提示词资产
              </DropdownMenuItem>
            )}
            {round.shareable !== false && (
              <DropdownMenuItem onSelect={() => { void onDeleteBatch?.(round.jobId, round.imagePaths); }}>
                <DeleteIcon className="shrink-0" aria-hidden />
                删除该批次结果
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
        {(runMeta.length > 0 || round.generationCost != null) && (
          <Hint label="耗时 · 完成时间 · 费用"><p data-testid="round-run-meta" className={ROUND_RUN_META_CLASS}>
            {runMeta.length > 0 && <span>{runMeta.join(' · ')}</span>}
            {runMeta.length > 0 && round.generationCost != null && <span aria-hidden>·</span>}
            {round.generationCost != null && (
              <span data-testid="round-generation-cost" className="shrink-0">
                {formatGenerationCost(round.generationCost)}
              </span>
            )}
          </p></Hint>
        )}
      </div>}
    </section>
  );
}

/** 结果卡：与占位卡同一个按目标比例的框（读到真实尺寸后改用真实比例）。
 *  刚生成完的结果先垫着占位交接层，媒体解码后在它上面淡入；历史结果直接在卡片底色上淡入。 */
function ResultFrame({ config, justCompleted, startedAt, progressKey, roundJob, testId, className, onClick, media, children }: {
  config: RoundConfig;
  justCompleted: boolean;
  startedAt: number;
  /** 所属轮次的 key：交接层细条从占位细条画到的位置起冲。 */
  progressKey: string;
  roundJob?: string;
  testId: string;
  className: string;
  onClick?: () => void;
  media: (handlers: { onSize: (width: number, height: number) => void; onReady: () => void }) => ReactNode;
  children: ReactNode;
}) {
  const [style, onSize] = useResultAspect(aspectStyle(config));
  const [revealed, setRevealed] = useState(false);
  return (
    <figure data-round-job={roundJob} data-testid={testId} style={style} className={className} onClick={onClick}>
      {justCompleted && (
        <CompletionUnderlay
          revealed={revealed}
          startedAt={startedAt}
          progressKey={progressKey}
          expectedMs={expectedDurationMs(config.kind, config.duration)}
        />
      )}
      {media({ onSize, onReady: () => setRevealed(true) })}
      {children}
    </figure>
  );
}

// forwardRef：作为 DropdownMenuTrigger 的 asChild 子元素要接住 ref 与注入的事件
const ActionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { compact?: boolean }>(
  function ActionButton({ compact = false, className = '', ...props }, ref) {
    return (
      <Button variant="bare"
        ref={ref}
        type="button"
        // 文字操作是实心底的按钮；「…」这类图标按钮保持无底。
        className={`inline-flex items-center justify-center h-8 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${compact
          ? 'w-8 px-0 rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
          : 'px-3 rounded-md bg-secondary text-foreground hover:bg-secondary/70 disabled:opacity-50'} ${className}`}
        {...props}
      />
    );
  },
);

function FailedCard({
  round, embedded, showActions,
  onDeleteFailed,
  onReEdit,
  reuseParameter,
  onRegenerate,
  onReuseReferences,
  mediaActive,
}: {
  embedded: boolean;
  showActions: boolean;
  round: Extract<RoundState, { kind: 'failed' }>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  reuseParameter?: ParameterReuse;
  onRegenerate?: (config: RoundConfig, failedJobId?: string) => void | Promise<void>;
  onReuseReferences?: (config: RoundConfig, jobId?: string) => void | Promise<void>;
  mediaActive: boolean;
}) {
  const { config } = round;
  const summary = failureSummary(round.reason);
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <section className={embedded ? "contents" : ROUND_SECTION_CLASS}>
      {config && !embedded && (
        <div className={ROUND_HEADER_CLASS}>
          <div className={ROUND_PROMPT_ROW_CLASS}>
            <ReferenceStack
              config={config}
              jobId={round.jobId}
              onReuse={onReuseReferences}
              mediaActive={mediaActive}
            />
            <div className="min-w-0 flex-1">
              <MentionPrompt
                prompt={config.prompt}
                config={config}
                jobId={round.jobId}
                mediaActive={mediaActive}
                onUsePrompt={onReEdit ? () => { void onReEdit(config, round.jobId); } : undefined}
              />
            </div>
          </div>
          <SpecChips config={config} reuseParameter={reuseParameter} />
        </div>
      )}
      <div
        data-round-job={embedded ? round.jobId : undefined}
        data-testid={round.canceled ? 'studio-canceled-note' : undefined}
        className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${round.canceled ? 'border-border bg-card/40' : 'border-destructive/30 bg-destructive/5'}`}
      >
        {round.canceled
          ? <StopIcon size="sm" className="mt-1 shrink-0 fill-current text-muted-foreground" aria-hidden />
          : <WarningIcon className="mt-0.5 shrink-0 text-destructive/70" aria-hidden />}
        <div className="min-w-0 flex-1 text-muted-foreground">
          <p className="[overflow-wrap:anywhere]">{summary}</p>
          {summary !== round.reason && (
            <>
              {detailOpen && <p className="mt-2 text-xs [overflow-wrap:anywhere]">{round.reason}</p>}
              <Button variant="bare"
                type="button"
                aria-expanded={detailOpen}
                onClick={() => setDetailOpen(open => !open)}
                className="mt-1 rounded-sm text-xs text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {detailOpen ? '收起' : '展开'}
              </Button>
            </>
          )}
        </div>
        {round.jobId && onDeleteFailed && (
          <Hint label={round.canceled ? '删除已停止记录' : '删除失败记录'}><Button variant="bare"
            type="button"
            aria-label={round.canceled ? '删除已停止记录' : '删除失败记录'}
            onClick={() => { void onDeleteFailed(round.jobId!); }}
            className={round.canceled
              ? 'shrink-0 whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              : 'shrink-0 whitespace-nowrap rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'}
          >
            删除
          </Button></Hint>
        )}
      </div>
      {config && showActions && (
        <div className={ROUND_ACTIONS_CLASS}>
          <ActionButton onClick={() => { void onReEdit?.(config, round.jobId); }}>重新编辑</ActionButton>
          <ActionButton onClick={() => { void onRegenerate?.(config, round.jobId); }}>再次生成</ActionButton>
        </div>
      )}
    </section>
  );
}
