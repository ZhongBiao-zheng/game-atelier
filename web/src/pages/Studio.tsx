import { connectionFetch } from '@/api/connection';
import { useHeicAsJpeg } from '@/lib/heicImages';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, motionAvailable } from '@/lib/motion';
import { useLocation, useSearch } from 'wouter';
import { ScrollBottomIcon } from '@/components/ui/icons';

import { addStudioResultToCanvas, createStudioJob, deleteStudioRound, findStudioJobByRequest, getStudioJob, newStudioRequestId, requeryStudioJob, resolveImageReferencePaths, submissionRejected, uploadReferenceImage } from '@/api/studio';
import { restoreTrash } from '@/api/trash';
import { agentSessionPath } from '@/api/canvas';
import { notify, clipName, UNDO_DURATION_MS } from '@/lib/notify';
import { errorText } from '@/lib/errorText';
import { presentJobError, type JobErrorAction } from '@/lib/errorPresentation';
import { maxReferenceImages } from '@/lib/referenceLimits';
import { modelDisplayName } from '@/lib/modelCatalog';
import { ApiError, apiError } from '@/api/http';
import { authenticateCollab, listCollabPeers } from '@/api/collab';
import { shareStudioResult } from '@/api/collabTransfer';
import { COLLAB_PROTOCOL_VERSION, type CollabCard } from '@/schema/collab';
import { SharedCanvasPasscodeDialog } from '@/components/canvas/SharedCanvasPasscodeDialog';
import { takeSharedStudioInput } from './sharedStudioInput';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { loadTokenDancePrices } from '@/api/usage';
import { listModelRoutes, type ModelRoute } from '@/api/models';
import { useSSE, type JobChangedPayload } from '@/hooks/useSSE';
import { listStudioAgentJobs } from '@/api/canvas';
import { StudioSessionControls } from '@/components/studio/StudioSessionControls';
import { StudioAgentTurnCard } from '@/components/studio/StudioAgentTimeline';
import { StudioComposer, useStudioComposer } from '@/components/studio/StudioComposer';
import type { InputFlashRequest } from '@/components/studio/PromptInput';
import {
  CreationAssetPanel,
  type CreationAssetPanelHandle,
  type CreationAssetPanelMode,
  type CreationAssetSaveRequest,
} from '@/components/assets/CreationAssetPanel';
import { MAX_REF_IMAGES, type FrameSlots } from '@/components/studio/VideoReferenceAssets';
import { EMPTY_MJ_REFS, routeReusedImageFiles, type MjRefSlots } from '@/components/studio/MjReferenceSlots';
import { RoundList, type CanvasTarget, type RoundConfig, type RoundFailure, type RoundState, type SaveResultAssetRequest } from '@/components/studio/RoundList';
import type { StudioAgentSession, StudioAgentTurn } from '@/schema/canvas';
import { StudioQueryBar } from '@/components/studio/StudioQueryBar';
import { TeamShareDialog, type TeamShareDialogRequest } from '@/components/studio/TeamShareDialog';
import { gptImage26JobParams, imageSizeMode, normalizeImageSizeParams, prepareImageSizeSubmission } from '@/lib/imageSizeMode';
import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import { imageFamily, isEvolinkMidjourney } from '@/lib/modelFamily';
import { promptToAssetSegments } from '@/lib/promptVariables';
import { evolinkMjParams, hasSrefCode, MJ_DEFAULTS, mjParamsToJob, type MjParams } from '@/lib/mjParams';
import { nearestDuration, videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import { deriveGenMode, filterRounds, hasHistoryFilters, mixedTimeline, type TimelineRound, DEFAULT_HISTORY_FILTERS, type HistoryFilters } from '@/lib/historyFilters';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { isAutoProvider, resolveChannel, sizeContext, withAutoProvider } from '@/lib/modelRoutes';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { useGalleryHidden } from '@/hooks/useGalleryHidden';
import { StudioCompact } from './StudioCompact';
import { convergeModelSelection, modelsForKind } from './studioModelSelection';
import type { Job, JobErrorCode, JobKind, JobParams } from '@/schema/jobs';
import {
  DEFAULT_STUDIO_SESSION_ID, NEW_SESSION_DRAFT_KEY, deleteSessionInput, readSessionInput, readStudioDraft,
  markStudioInputSubmitted, writeSessionInput, writeStudioDraft, type StudioInputMode, type StudioSessionInput,
} from './studioDraft';
import { clampImageCount, configForJob, isOmniVideoConfig } from './studioJobConfig';
import { routeStudioMediaAsset } from './studioAssetRouting';
import { recipeToDraft } from './studioRecipe';
import { costLabel, referenceImageLimit, studioEstimateLabel } from './studioEstimate';
import { creationAssetInputUrl, readCreationMediaFile, markCreationAssetUsed } from '@/api/creationAssets';
import { listCanvasProjects } from '@/api/canvas';
import { adoptTeamAsset, fetchProfile, listTeamLibraries } from '@/api/teamLibraries';
import { TEAM_ASSET_ACTION_EVENT, teamAssetActionFromSearch, type TeamAssetAction } from '@/lib/teamAssetActions';
import type { CreationAsset, CreationMediaAssetContent, RecipeInput } from '@/schema/creationAssets';
import type { CanvasProject } from '@/schema/canvas';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';

import { reuseRoundParameter, type RoundParameter } from './studioParameterReuse';
import { agentUsageLabel } from '@/components/agent/canvasAgentUsage';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

const SELECTION_STORAGE_KEY = 'studio:selection';
const ASSET_TITLE_LENGTH = 24;
/** 深链定位后的两次纠偏时刻（图片异步加载会把布局往下推）。 */
const DEEP_LINK_SETTLE_MS = [600, 1600] as const;
/** 目标轮描边：300ms 进场 + 停留 1s，之后淡出。 */
const DEEP_LINK_HIGHLIGHT_MS = 1300;
const NOTICE_MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0 },
  transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle },
} as const;

/** 搜索 / 筛选把结果筛空：先等 150ms 确认（快速打字时不闪），再 200ms 淡入。 */
function FilteredEmpty() {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !motionAvailable()) return;
    element.style.opacity = '0';
    const controls = animate(element, { opacity: [0, 1] }, {
      delay: MOTION_DURATION.fast,
      duration: MOTION_DURATION.base,
      ease: MOTION_EASE.subtle,
    });
    clearOnFinish(controls, element, ['opacity']);
    return () => controls.stop();
  }, []);
  return <p ref={ref} className="my-auto text-center font-display text-display italic text-foreground/70">没有匹配的记录</p>;
}

interface RoundReferenceFiles {
  images: File[];
  videos: File[];
  audios: File[];
  sref: File[];
  cref: File[];
  oref: File[];
}

/** 一次提交要上传的本地素材：上传失败时留着，「再次生成」用它们重新上传。 */
interface SubmissionFiles {
  images: File[];
  mjRefs: MjRefSlots;
  frames: File[] | null;
  videos: File[];
  audios: File[];
}

/** 覆盖输入前的整套编辑器状态：「已替换当前输入 · 撤销」按它还原。 */
interface EditorSnapshot {
  mode: StudioInputMode;
  providerAlias: string;
  model: string;
  sizeParams: JobParams;
  count: number;
  quality: Quality;
  mjParams: MjParams;
  videoMode: VideoMode;
  duration: number;
  videoResolution: string;
  videoRatio: string;
  videoQuality: VideoQuality;
  videoCount: number;
  generateAudio: boolean;
  input: StudioSessionInput;
}

const EMPTY_SESSION_INPUT: StudioSessionInput = {
  promptText: '', promptAssetSourceTitle: null,
  referenceImages: [], referenceVideos: [], referenceAudios: [],
  videoFrames: { first: null, last: null }, mjRefs: EMPTY_MJ_REFS, agentText: '', agentFiles: [],
};

/** 历史配置 → 估价用的任务参数（与提交时写进 params 的字段同名）。 */
function configCostParams(config: RoundConfig): JobParams {
  if (config.kind === 'video') {
    return {
      duration: config.duration, resolution: config.videoResolution, ratio: config.ratio, n: config.n,
      ...(config.videoQuality ? { mode: config.videoQuality } : {}),
      generate_audio: config.generateAudio,
      reference_images: config.referenceImages, reference_videos: config.referenceVideos ?? [],
    };
  }
  return {
    size_mode: config.sizeMode, size: config.size, ratio: config.ratio, resolution: config.resolution,
    n: config.n, ...(config.quality ? { quality: config.quality } : {}),
    reference_images: config.referenceImages,
  };
}

/** 复刻后输入框上方的常驻提示：本机缺的模型 + 配方还原时丢掉的东西。 */
interface RecipeNotice {
  missingModel: string | null;
  warnings: string[];
}

function assetTitleFromPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, ASSET_TITLE_LENGTH);
}

interface SavedSelection {
  providerAlias?: string;
  model?: string;
  sizeParams?: JobParams;
  count?: number;
  quality?: Quality;
  kind?: JobKind;
  videoMode?: VideoMode;
  duration?: number;
  videoResolution?: string;
  videoRatio?: string;
  videoQuality?: VideoQuality;
  videoCount?: number;
  generateAudio?: boolean;
}

function loadSelection(): SavedSelection {
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedSelection) : {};
  } catch {
    return {};
  }
}

function saveSelection(sel: SavedSelection): void {
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(sel));
  } catch {
    // localStorage 不可用（隐私模式等）时静默跳过，不影响出图。
  }
}

export function Studio({ compact = false }: { compact?: boolean }) {
  return compact ? <StudioCompact /> : <StudioFull />;
}

function StudioFull() {
  const composer = useStudioComposer();
  const scopedId = composer.agent.selectedSessionId;
  const [saved] = useState(loadSelection);
  const [draft] = useState(readStudioDraft);
  const [localRounds, setRounds] = useState<(RoundState & { sessionId: string })[]>([]);
  // 查询面板筛选 + 收藏/隐藏集（渲染端筛选用，state 仍保留全量轮）。setHistoryFilters 喂 StudioQueryBar，
  // toggleFavorite 透传到结果卡 ★ 收藏按钮。
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const { favorites, toggleFavorite } = useGalleryFavorites();
  const { hiddenPaths, toggleHidden } = useGalleryHidden();
  const [persistedJobs, setPersistedJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState(false);
  // 提交（含参考上传）失败的次数：每多一次，提交按钮水平微抖一下，失败原因落在记录里的失败卡上。
  const [submitFailures, setSubmitFailures] = useState(0);
  // 从记录里带进输入壳的东西（重新编辑 / 使用提示词 / 编辑为参考）：落点闪一次主题色描边。
  const [inputFlash, setInputFlash] = useState<InputFlashRequest | null>(null);
  const flashInput = (area: InputFlashRequest['area']) => setInputFlash(previous => ({ id: (previous?.id ?? 0) + 1, area }));
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  // 厂商列表 =「自动」+ 真实 KEY；选择、能力、收敛都在这份列表上做，实际渠道用 resolveChannel 取。
  const providers = useMemo(() => withAutoProvider(keys, routes), [keys, routes]);
  // 公告「快速添加」等别处改了密钥的模型列表：只刷新列表，不动当前选中的供应商 / 模型。
  useEffect(() => {
    const refresh = () => {
      void listKeys().then(resp => setKeys(resp.keys.filter(key => key.enabled !== false && key.models.length > 0))).catch(() => undefined);
      void listModelRoutes().then(setRoutes).catch(() => undefined);
    };
    window.addEventListener(KEYS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(KEYS_CHANGED_EVENT, refresh);
  }, []);
  // listKeys 返回（成功或失败）后才为 true：区分「还在加载」与「加载完了但一个 key 都没有」。
  const [keysLoaded, setKeysLoaded] = useState(false);
  // 滚动联动收放：历史区 col-reverse（|scrollTop| 即距底距离），>160 收 / <80 展（滞回防抖）。
  // shellFocused / clickPinned 是两个展开覆盖：输入焦点期间恒展开；点击收缩壳展开但不回滚，
  // 再次滚动（dist>160 的 scroll 事件）即取消点击钉住。
  const scrollRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [shellFocused, setShellFocused] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
  const [reuseLimitNotice, setReuseLimitNotice] = useState(false);
  const [assetNotice, setAssetNotice] = useState<string | null>(null);
  const [location, setLocation] = useLocation();
  const [shareRequest, setShareRequest] = useState<TeamShareDialogRequest | null>(null);
  // 覆盖了非空输入（重新编辑 / 使用提示词 / 复用参考 / 复刻）：输入壳上方给 8 秒「撤销」。
  const [replacedInput, setReplacedInput] = useState<{ id: number; snapshot: EditorSnapshot } | null>(null);
  const [replacedPaused, setReplacedPaused] = useState(false);
  const [recipeNotice, setRecipeNotice] = useState<RecipeNotice | null>(null);
  const dockCollapsed = scrolledUp && !shellFocused && !clickPinned;

  // 不走 rAF 节流：后台标签页 rAF 会挂起导致联动滞后；setState 同值自动 bail-out，开销可忽略。
  const handleHistoryScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = Math.abs(el.scrollTop);
    // 弹窗关闭时聚焦的选项会被卸载，浏览器可能不发 blur。滚动时以实际焦点为准。
    setShellFocused(Boolean(dockRef.current?.contains(document.activeElement)));
    setScrolledUp((prev) => (prev ? dist > 80 : dist > 160));
    if (dist > 160 || dist <= 80) setClickPinned(false);
  };

  // 瞬时跳转（飙哥指定）：回到底部不要从上往下滚的过程。
  const scrollToBottom = () => scrollRef.current?.scrollTo?.({ top: 0, behavior: 'auto' });

  const session = composer.agent.session && 'turns' in composer.agent.session ? composer.agent.session : null;
  const scopedJobs = useMemo(() => persistedJobs.filter(job => jobSessionId(job) === scopedId), [persistedJobs, scopedId]);
  // 本地占位轮交接给服务端任务时，任务沿用占位的客户端 id 与起点：整卡不重挂，转圈不重启，计时不跳。
  const handoffs = useRef(new Map<string, RoundHandoff>());
  const rounds = useMemo(() => [
    ...localRounds.filter(round => round.sessionId === scopedId),
    ...studioJobsToRounds(scopedJobs.filter(job => !job.studio_agent_turn_id), keys)
      .map(round => withHandoff(round, handoffs.current)),
  ], [localRounds, scopedId, scopedJobs, keys]);
  const timeline = useMemo(() => mixedTimeline(rounds, session, scopedJobs), [rounds, session, scopedJobs]);
  const visibleRounds = useMemo(() => filterRounds(timeline, historyFilters, favorites, hiddenPaths),
    [timeline, historyFilters, favorites, hiddenPaths]);
  const usage = session && agentUsageLabel(composer.agent.usage);
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  // 尺寸、质量、张数都记住（与视频参数一致）：刷新后回到上次的选择。
  const [sizeParams, setSizeParams] = useState<JobParams>(draft?.sizeParams ?? saved.sizeParams ?? {});
  const [count, setCount] = useState(draft?.count ?? clampImageCount(saved.count ?? 1));
  const [quality, setQuality] = useState<Quality>(draft?.quality ?? saved.quality ?? 'low');
  // MJ 参数不进 localStorage —— 与 ratio/像素/质量/数量 同一政策：出图配置每次启动回默认。
  const [mjParams, setMjParams] = useState<MjParams>(draft?.mjParams ?? MJ_DEFAULTS);
  // MJ 四个语义参考组；每组允许多图，垫图最终仍落 reference_images。
  const [mjRefs, setMjRefs] = useState<MjRefSlots>(draft?.mjRefs ?? EMPTY_MJ_REFS);
  const [promptText, setPromptText] = useState(draft?.promptText ?? '');
  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [assetPanelKind, setAssetPanelKind] = useState<CreationAssetPanelMode>('prompt');
  // 面板只在挂载与 initialKind 变化时同步栏位；「看看」要确定落在团队栏，就换 key 重新挂载。
  const [assetPanelMount, setAssetPanelMount] = useState(0);
  // 「看看」定位：团队栏初始落在挂着该库的画布与该库上。
  const [teamPanelTarget, setTeamPanelTarget] = useState<{ projectId: string; libraryId: string } | null>(null);
  const [assetSaveRequest, setAssetSaveRequest] = useState<CreationAssetSaveRequest | null>(null);
  const assetPanelRef = useRef<CreationAssetPanelHandle>(null);
  const [canvasTargets, setCanvasTargets] = useState<CanvasProject[]>([]);
  const canvasTargetOptions = useMemo<CanvasTarget[]>(
    () => canvasTargets.map(target => ({ projectId: target.project_id, name: target.name })), [canvasTargets]);
  const [sharedTargets, setSharedTargets] = useState<CollabCard[]>([]);
  const [sharedAuth, setSharedAuth] = useState<{
    target: CollabCard; needsName: boolean; jobId: string; index: number;
  } | null>(null);
  const roundCanvasOptions = useMemo<CanvasTarget[]>(() => [
    ...canvasTargetOptions, ...sharedTargets.map(card => ({
      projectId: card.peer_key + '/' + card.project_id, name: card.name, sharedBy: card.display_name,
    })),
  ], [canvasTargetOptions, sharedTargets]);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const cards = await listCollabPeers();
        if (active) setSharedTargets(cards.filter(card => !card.is_self && card.mode === 'edit'
          && card.protocol_version === COLLAB_PROTOCOL_VERSION));
      } catch { if (active) setSharedTargets([]); }
    }
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [promptAssetSourceTitle, setPromptAssetSourceTitle] = useState<string | null>(draft?.promptAssetSourceTitle ?? null);
  const [referenceImages, setReferenceImages] = useState<File[]>(draft?.referenceImages ?? []);
  const kind = composer.mode === 'video' ? 'video' : 'image';
  const setKind = composer.switchMode;
  // 旧版本 videoMode 存过 t2v/i2v/ref/v2v —— 仅 'omni' 原样保留，其余一律回落首尾帧。
  const [videoMode, setVideoMode] = useState<VideoMode>(draft?.videoMode ?? (saved.videoMode === 'omni' ? 'omni' : 'firstlast'));
  const [duration, setDuration] = useState<number>(draft?.duration ?? saved.duration ?? 5);
  const [videoResolution, setVideoResolution] = useState<string>(draft?.videoResolution ?? saved.videoResolution ?? '720p');
  const [videoRatio, setVideoRatio] = useState<string>(draft?.videoRatio ?? saved.videoRatio ?? '16:9');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(draft?.videoQuality ?? (saved.videoQuality === 'pro' ? 'pro' : 'std'));
  const [videoCount, setVideoCount] = useState<number>(draft?.videoCount ?? clampImageCount(saved.videoCount ?? 1));
  const [videoSeed, setVideoSeed] = useState<number | undefined>(draft?.videoSeed);
  const [generateAudio, setGenerateAudio] = useState<boolean>(draft?.generateAudio ?? saved.generateAudio ?? false);
  const [referenceVideos, setReferenceVideos] = useState<File[]>(draft?.referenceVideos ?? []);
  const [referenceAudios, setReferenceAudios] = useState<File[]>(draft?.referenceAudios ?? []);
  // 首尾帧模式的双槽（与 referenceImages 分离：两个槽各自独立可空，仅尾帧也合法）。
  const [videoFrames, setVideoFrames] = useState<FrameSlots>(draft?.videoFrames ?? { first: null, last: null });
  // 来源标题跟着它的来源对象走：来自参考图的，那张参考被移除时一起清空（Windows 实测 W3）。
  // 来自提示词资产或复用配置的不记文件，保持原行为。
  const sourceTitleFile = useRef<File | null>(null);
  // HEIC 参考在后台换成 JPEG 时，跟踪的文件跟着换，标题不会被当成「参考已移除」清掉。
  const followHeicReplacement = useCallback((converted: ReadonlyMap<File, File>) => {
    const next = sourceTitleFile.current && converted.get(sourceTitleFile.current);
    if (next) sourceTitleFile.current = next;
  }, []);
  // iPhone 的 HEIC 照片 Chrome 预览不了：无论从哪个入口进来，都在后台换成 JPEG。
  useHeicAsJpeg(referenceImages, setReferenceImages, setAssetNotice, followHeicReplacement);
  useEffect(() => {
    const file = sourceTitleFile.current;
    if (!file) return;
    const present = [referenceImages, referenceVideos, referenceAudios, [videoFrames.first, videoFrames.last],
      ...Object.values(mjRefs)].some(list => list.includes(file));
    if (!present) { sourceTitleFile.current = null; setPromptAssetSourceTitle(null); }
  }, [referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs]);
  useHeicAsJpeg(mjRefs, setMjRefs, setAssetNotice, followHeicReplacement);
  useHeicAsJpeg(videoFrames, setVideoFrames, setAssetNotice, followHeicReplacement);

  const teamReferenceFiles = useRef(new Map<string, File>());
  const referenceSlots = useRef({ referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs });
  referenceSlots.current = { referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs };

  const draftKey = scopedId ?? NEW_SESSION_DRAFT_KEY;
  // 每次改动都把未提交的输入写进内存草稿；切页卸载后回来按它恢复，刷新即清空。
  useEffect(() => {
    writeStudioDraft({
      providerAlias, model, kind, promptText, promptAssetSourceTitle,
      referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs, mjParams,
      sizeParams, count, quality,
      videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio, videoSeed,
    }, draftKey);
  }, [
    providerAlias, model, kind, promptText, promptAssetSourceTitle,
    referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs, mjParams,
    sizeParams, count, quality,
    videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio, videoSeed, draftKey,
  ]);

  // ---- 草稿按对话存：切走时留在原对话，切回来原样恢复；新对话发出第一条建了会话时，输入跟着走。 ----
  const { setText: setAgentText, setFiles: setAgentFilesRaw } = composer;
  const sessionInput: StudioSessionInput = {
    promptText, promptAssetSourceTitle, referenceImages, referenceVideos, referenceAudios,
    videoFrames, mjRefs, videoSeed, agentText: composer.text, agentFiles: composer.files,
  };
  const editor: EditorSnapshot = {
    mode: composer.mode, providerAlias, model, sizeParams, count, quality, mjParams,
    videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    input: sessionInput,
  };
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const draftKeyRef = useRef(draftKey);
  const applySessionInput = useCallback((input: StudioSessionInput) => {
    sourceTitleFile.current = null;
    setPromptText(input.promptText);
    setPromptAssetSourceTitle(input.promptAssetSourceTitle);
    setReferenceImages(input.referenceImages);
    setReferenceVideos(input.referenceVideos);
    setReferenceAudios(input.referenceAudios);
    setVideoFrames(input.videoFrames);
    setVideoSeed(input.videoSeed);
    setMjRefs(input.mjRefs);
    setAgentText(input.agentText);
    setAgentFilesRaw(input.agentFiles);
  }, [setAgentText, setAgentFilesRaw]);
  useEffect(() => {
    const previous = draftKeyRef.current;
    if (previous === draftKey) return;
    draftKeyRef.current = draftKey;
    const current = editorRef.current.input;
    const stored = readSessionInput(draftKey);
    if (!stored && previous === NEW_SESSION_DRAFT_KEY) {
      writeSessionInput(draftKey, current);
      deleteSessionInput(NEW_SESSION_DRAFT_KEY);
      return;
    }
    writeSessionInput(previous, current);
    setReplacedInput(null);
    // 换到别的对话：还在取素材的重新编辑 / 复用参考 / 编辑为参考作废，结果不写进这段对话。
    reEditSequence.current += 1;
    applySessionInput(stored ?? EMPTY_SESSION_INPUT);
  }, [draftKey, applySessionInput]);
  useEffect(() => {
    writeSessionInput(draftKeyRef.current, sessionInput);
    // sessionInput 每次渲染都是新对象：按它的各字段写。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptText, promptAssetSourceTitle, referenceImages, referenceVideos, referenceAudios,
    videoFrames, mjRefs, videoSeed, composer.text, composer.files]);

  // ---- 覆盖输入：直接覆盖，输入壳上方给 8 秒「已替换当前输入 · 撤销」（悬停暂停）。 ----
  function snapshotIfFilled(): EditorSnapshot | null {
    return hasEditorInput() ? editorRef.current : null;
  }
  function offerUndo(before: EditorSnapshot | null) {
    if (!before) return;
    setReplacedPaused(false);
    setReplacedInput(current => ({ id: (current?.id ?? 0) + 1, snapshot: before }));
  }
  function undoReplace() {
    const snapshot = replacedInput?.snapshot;
    setReplacedInput(null);
    if (!snapshot) return;
    reEditSequence.current += 1;
    setRecipeNotice(null);
    setKind(snapshot.mode);
    setProviderAlias(snapshot.providerAlias);
    setModel(snapshot.model);
    setSizeParams(snapshot.sizeParams);
    setCount(snapshot.count);
    setQuality(snapshot.quality);
    setMjParams(snapshot.mjParams);
    setVideoMode(snapshot.videoMode);
    setDuration(snapshot.duration);
    setVideoResolution(snapshot.videoResolution);
    setVideoRatio(snapshot.videoRatio);
    setVideoQuality(snapshot.videoQuality);
    setVideoCount(snapshot.videoCount);
    setGenerateAudio(snapshot.generateAudio);
    applySessionInput(snapshot.input);
  }
  useEffect(() => {
    if (!replacedInput || replacedPaused) return;
    const timer = window.setTimeout(() => setReplacedInput(null), UNDO_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [replacedInput, replacedPaused]);

  // 资产面板与结果卡「加入画布」共用这份画布列表：挂载时读一次，打开面板时刷新。
  useEffect(() => {
    let cancelled = false;
    void listCanvasProjects(true)
      .then(projects => { if (!cancelled) setCanvasTargets(Array.isArray(projects) ? projects : []); })
      .catch(() => { if (!cancelled) setCanvasTargets([]); });
    return () => { cancelled = true; };
  }, [assetPanelOpen]);
  // 重新编辑会异步拉取历史参考素材；只允许最后一次点击的结果回填，避免慢请求覆盖新选择。
  const reEditSequence = useRef(0);
  const channel = resolveChannel(keys, providers.find((k) => k.alias === providerAlias), model);
  const selectedModelObj = channel.key?.models.find((m) => m.id === channel.modelId);
  const videoCaps = videoControlCaps(channel.modelId, selectedModelObj?.protocol, selectedModelObj?.declared);
  const imageCaps = sizeContext(providers, providers.find(item => item.alias === providerAlias), model).caps;
  // 切模型不截参考：超出新模型上限的留在输入里置灰，提交时只发前 N 张；换回模型自动恢复。
  const imageReferenceLimit = referenceImageLimit({
    agent: composer.mode === 'agent', kind, videoMode, imageCaps, videoCaps, model,
  });
  const overLimit = imageReferenceLimit !== null && referenceImages.length > imageReferenceLimit;
  const estimateLabel = composer.mode === 'agent' || !model ? null : studioEstimateLabel({
    key: channel.key, modelId: channel.modelId, kind, imageCaps, sizeParams, count, quality,
    referenceImages: referenceImages.length, videoCaps, videoCount, duration, videoResolution, videoRatio,
    videoQuality, generateAudio, referenceVideos: referenceVideos.length,
  });
  // 切换生成类型 / keys 加载时把 alias、model 收敛到本类模型（规则见 convergeModelSelection）：
  // 界面显示的模型就是提交的模型；复刻缺模型（model 为空）时只换 key，模型位留空。
  useEffect(() => {
    const next = convergeModelSelection(providers, kind, providerAlias, model);
    if (!next) return;
    setProviderAlias(next.alias);
    setModel(next.model);
    // 仅在切换类型 / keys 加载时触发；alias / model 不入依赖，避免用户改选时被反复抢回成死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, providers]);
  // 切换视频模型族时把超出 caps 的选择拉回合法值（如 seedance 21:9 → kling 没有；kling 档位 ↔ seedance 无档位）。
  useEffect(() => {
    // 模型未定（复刻缺模型）时不按兜底 caps 钳制：配方的时长 / 分辨率 / 比例留到用户选了模型再按它收。
    if (kind !== 'video' || !model) return;
    const selected = resolveChannel(keys, providers.find((k) => k.alias === providerAlias), model);
    const selModel = selected.key?.models.find((m) => m.id === selected.modelId);
    const caps = videoControlCaps(selected.modelId, selModel?.protocol, selModel?.declared);
    if (!caps.modes.includes(videoMode)) setVideoMode(caps.modes[0]);
    if (caps.ratios.length > 0 && !caps.ratios.includes(videoRatio)) setVideoRatio(caps.ratios[0]);
    if (caps.durations.length > 0 && !caps.durations.includes(duration)) setDuration(nearestDuration(caps.durations, duration));
    if (caps.resolutions.length > 0 && !caps.resolutions.includes(videoResolution)) {
      setVideoResolution(caps.resolutions[0]);
    }
    if (caps.qualities && !caps.qualities.includes(videoQuality)) setVideoQuality(caps.qualities[0]);
  }, [kind, keys, providers, providerAlias, model, videoMode, videoRatio, duration, videoResolution, videoQuality]);
  const handleSizeParamsChange = useCallback((patch: JobParams) => {
    setSizeParams(previous => {
      const size = sizeContext(providers, providers.find(key => key.alias === providerAlias), model);
      return normalizeImageSizeParams(size.modelId, size.provider, size.baseUrl, { ...previous, ...patch }, size.caps);
    });
  }, [providers, providerAlias, model]);

  const reuseParameter = (config: RoundConfig, parameter: RoundParameter) => {
    const patch = reuseRoundParameter(config, parameter, { providers, alias: providerAlias, model, kind, sizeParams });
    if (!patch) {
      if (parameter === 'model') return '该模型已不可用';
      if ((config.kind ?? 'image') !== kind) return `切换到${config.kind === 'video' ? '视频' : '图片'}模式后可用`;
      return '当前模型不支持';
    }
    return () => {
      if (patch.alias !== undefined) setProviderAlias(patch.alias);
      if (patch.model !== undefined) {
        setModel(patch.model);
        setRecipeNotice(current => withoutMissingModel(current));
      }
      if (patch.kind === 'image' || patch.kind === 'video') setKind(patch.kind);
      if (patch.sizeParams !== undefined) setSizeParams(patch.sizeParams);
      if (patch.quality !== undefined) setQuality(patch.quality);
      if (patch.count !== undefined) setCount(patch.count);
      if (patch.videoRatio !== undefined) setVideoRatio(patch.videoRatio);
      if (patch.videoResolution !== undefined) setVideoResolution(patch.videoResolution);
      if (patch.videoQuality !== undefined) setVideoQuality(patch.videoQuality);
      if (patch.videoCount !== undefined) setVideoCount(patch.videoCount);
      if (patch.duration !== undefined) setDuration(patch.duration);
      if (patch.generateAudio !== undefined) setGenerateAudio(patch.generateAudio);
      setClickPinned(true);
    };
  };

  // 点击历史记录里的参考图 → 把这批参考图（服务器路径）拉回成 File[]，整组塞进输入框复用出图。
  const handleReuseReferences = async (config: RoundConfig, jobId?: string) => {
    const requestSequence = ++reEditSequence.current;
    let files: RoundReferenceFiles;
    try {
      files = await fetchRoundReferences(config, jobId);
    } catch (error) {
      if (requestSequence !== reEditSequence.current) return;
      setAssetNotice(errorText(error, '参考素材恢复失败'));
      return;
    }
    // 取素材期间切了对话或又点了别的：旧结果不写进当前输入。
    if (requestSequence !== reEditSequence.current) return;
    const { images, videos, audios, sref, cref, oref } = files;
    const before = snapshotIfFilled();
    const routed = routeReusedImageFiles(model, config.model, { image: images, sref, cref, oref });
    setReferenceImages(routed.referenceImages);
    setReferenceVideos(videos);
    setReferenceAudios(audios);
    setMjRefs(routed.mjRefs);
    setReuseLimitNotice(routed.droppedCount > 0);
    flashInput('references');
    offerUndo(before);
  };

  useEffect(() => {
    if (!reuseLimitNotice) return;
    const timer = window.setTimeout(() => setReuseLimitNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [reuseLimitNotice]);

  useEffect(() => {
    if (!assetNotice) return;
    const timer = window.setTimeout(() => setAssetNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [assetNotice]);

  // 图卡左下角「编辑」→ 把这张生成结果取回成 File，塞进「当前模式下真正会被提交的那个槽位」。
  // 一律塞 referenceImages 是错的：MJ 和视频首尾帧模式下通用参考图栏位是隐藏的，
  // 图导进去既看不见、提交时也走不到（MJ 只发 mjRefs.image，首尾帧只发 videoFrames）。
  //   视频 · 全能参考 → 参考素材堆叠（多张）
  //   视频 · 首尾帧   → 首帧槽（单槽，已有图则替换）
  //   图片 · MJ       → 垫图「图片」组（多图，去重追加）
  //   图片 · 其余     → 常规参考图堆叠（多张；同一张图只留一份）
  // 一进来就钉住展开输入壳：从深链/滚动上来时壳是收起的，不展开的话图落进收起条里看不见，
  // 用户以为没导入成功。这条链路全程不弹提示（飙哥指定，保持简约）——重复导入、替换、
  // 取图失败一律静默，槽位本身就是唯一反馈；失败只落 console 供排查。
  // 每个导入的 File 记住它的来源路径 —— 去重判据是 File 身份而不是文件名：
  // 不同 job 的输出常同名（v1.png / v2.png）。删掉后 File 不在数组里，同一张图可以再导。
  const editRefSource = useRef(new WeakMap<File, string>());
  const { mode: inputMode, files: agentFiles, setFiles: setAgentFiles } = composer;
  const handleEditAsReference = useCallback(async (path: string) => {
    const target: 'stack' | 'frame' | 'mj' = inputMode === 'agent' ? 'stack' : kind === 'video'
      ? (videoMode === 'omni' ? 'stack' : 'frame')
      : imageFamily(model) === 'midjourney' ? 'mj' : 'stack';
    setClickPinned(true);
    // 纯文生视频（maxFrames=0）没有首帧槽，导进去提交时也读不到 —— 不做无效写入。
    if (target === 'frame' && (videoCaps?.maxFrames ?? 2) < 1) return;
    const sourceOf = (f: File | null) => (f ? editRefSource.current.get(f) : undefined);
    const already = target === 'stack'
      ? (inputMode === 'agent' ? agentFiles : referenceImages).some((f) => sourceOf(f) === path)
      : target === 'frame'
        ? sourceOf(videoFrames.first) === path
        : mjRefs.image.some((f) => sourceOf(f) === path);
    // 已经导过同一张：不叠第二份。
    if (already) return;
    const requestSequence = reEditSequence.current;
    try {
      const file = await fetchAssetAsFile(path, path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'edit-ref');
      // 取图期间切了对话（或输入整套换过）：不写进别的对话的输入。
      if (requestSequence !== reEditSequence.current) return;
      editRefSource.current.set(file, path);
      if (inputMode === 'agent') {
        if (file.type.startsWith('image/')) setAgentFiles(prev => [...prev, file].slice(0, 16));
      } else if (target === 'frame') {
        setVideoFrames((prev) => ({ ...prev, first: file }));
      } else if (target === 'mj') {
        setMjRefs((prev) => ({ ...prev, image: [...prev.image, file] }));
      } else {
        setReferenceImages((prev) => [...prev, file]);
      }
      flashInput('references');
    } catch (e) {
      console.warn('[studio] 参考图导入失败（源文件取不到）', path, e);
    }
  }, [inputMode, agentFiles, setAgentFiles, kind, videoMode, model, videoCaps?.maxFrames, videoFrames.first, mjRefs.image, referenceImages]);

  // 首页作品深链（/studio?job=<id>）：目标轮出现在历史里后滚动定位（居中），一次性消费。
  useEffect(() => {
    if (!keysLoaded) return;
    const shared = takeSharedStudioInput();
    if (!shared) return;
    if (shared.kind === 'reference') {
      addReferenceFile(shared.file, shared.file.type, shared.title);
      return;
    }
    const snapshot = shared.generation;
    const before = snapshotIfFilled();
    if (snapshot.mode === 'image' || snapshot.mode === 'video') {
      const draft = recipeToDraft({
        mode: snapshot.mode, model: snapshot.model_id, provider: snapshot.provider, alias: null,
        final_prompt: snapshot.prompt, draft_prompt: null, params: snapshot.params, inputs: [],
        cost_cny: snapshot.cost_cny ?? null, cost_basis: null, submitted_at: snapshot.submitted_at ?? '',
      }, keys);
      const files: RoundReferenceFiles = { images: [], videos: [], audios: [], sref: [], cref: [], oref: [] };
      for (const { row, file } of shared.inputs) {
        if (row.role === 'mask' || row.role === 'markup') continue;
        const slot = row.role === 'mj_sref' ? 'sref' : row.role === 'mj_cref' ? 'cref'
          : row.role === 'mj_oref' ? 'oref' : row.kind === 'video' ? 'videos' : row.kind === 'audio' ? 'audios' : 'images';
        files[slot].push(file);
      }
      const textRefs = snapshot.inputs.flatMap(row => row.kind === 'text' && row.text ? [row.text] : []);
      applyRoundConfig({ ...draft.config, prompt: [draft.config.prompt, ...textRefs].join('\n') }, files);
      if (shared.inputs.some(({row}) => row.role === 'mask' || row.role === 'markup'))
        setAssetNotice('蒙版与标注保存在原画布中，创作台仅恢复常规参考素材');
      if (!draft.model) {
        setModel('');
        setRecipeNotice({ missingModel: `${snapshot.model_name || snapshot.model_id}（${snapshot.provider_label || snapshot.provider}）`, warnings: [] });
      }
    } else {
      setPromptText(snapshot.prompt);
    }
    offerUndo(before);
    // Consume the explicit handoff once the local model list is available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysLoaded]);
  const search = useSearch();
  const targetJobId = useMemo(() => new URLSearchParams(search).get('job'), [search]);
  const selectSession = composer.agent.selectSession;
  useEffect(() => {
    let active = true;
    if (targetJobId) void getStudioJob(targetJobId).then(job => {
      if (active && job?.namespace === 'studio' && jobSessionId(job) !== scopeRef.current) {
        void selectSession(jobSessionId(job));
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [targetJobId, selectSession]);
  const focusConsumedRef = useRef<string | null>(null);
  const [focusHighlight, setFocusHighlight] = useState(false);
  useEffect(() => {
    if (!targetJobId || focusConsumedRef.current === targetJobId) return;
    const found = scopedJobs.some(job => job.job_id === targetJobId);
    if (!found) return;
    focusConsumedRef.current = targetJobId;
    // 用户一动滚轮或手指，就把位置交给用户：后面的纠偏不再把他拽回去。
    let userScrolled = false;
    const yieldToUser = () => {
      userScrolled = true;
      window.removeEventListener('wheel', yieldToUser);
      window.removeEventListener('touchstart', yieldToUser);
    };
    window.addEventListener('wheel', yieldToUser, { passive: true });
    window.addEventListener('touchstart', yieldToUser, { passive: true });
    const scrollToRound = () => {
      if (userScrolled) return;
      document
        .querySelector(`[data-round-job="${CSS.escape(targetJobId)}"]`)
        ?.scrollIntoView({ block: 'center' });
    };
    // 图片异步加载会把布局往下推，定位后再补两次纠偏。
    // 不返回 cleanup：deps 里的 rounds 随 SSE/轮询频繁变化，effect 重跑会把上一轮的
    // 一次性定时器掐掉。定时器是幂等一次性动作，放着跑完即可。
    scrollToRound();
    setTimeout(scrollToRound, DEEP_LINK_SETTLE_MS[0]);
    setTimeout(() => { scrollToRound(); yieldToUser(); }, DEEP_LINK_SETTLE_MS[1]);
    // 定位后给目标轮一圈主题色描边：300ms 进，停 1s 后淡出，告诉用户「是这一条」。
    setFocusHighlight(true);
    setTimeout(() => setFocusHighlight(false), DEEP_LINK_HIGHLIGHT_MS);
  }, [scopedJobs, targetJobId, timeline]);

  // 分享提醒的「复刻」/「看看」：本页在就地认领；别的页面带着 ?team_asset= 跳过来，挂载后处理一次。
  const teamAssetActionRef = useRef<(action: TeamAssetAction) => void>(() => {});
  // 采用 / 记使用是异步的：回来时要用最新一帧的 requestReproduce（keys 可能在等待期间加载完）。
  const requestReproduceRef = useRef<(asset: CreationAsset) => void>(() => {});
  // keys 未加载时的复刻先记在这里，加载完由下面的 effect 补做。
  const pendingReproduceRef = useRef<CreationAsset | null>(null);
  useEffect(() => {
    teamAssetActionRef.current = handleTeamAssetAction;
    requestReproduceRef.current = requestReproduce;
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const action = (event as CustomEvent<TeamAssetAction | undefined>).detail;
      if (!action) return;
      event.preventDefault();
      teamAssetActionRef.current(action);
    };
    window.addEventListener(TEAM_ASSET_ACTION_EVENT, listener);
    return () => window.removeEventListener(TEAM_ASSET_ACTION_EVENT, listener);
  }, []);
  // 复刻要先判本机有没有配方模型，所以等 keys 加载完再处理：挂起的复刻与 ?team_asset= 都从这里出。
  const teamSearchHandledRef = useRef(false);
  useEffect(() => {
    if (!keysLoaded) return;
    const pendingReproduce = pendingReproduceRef.current;
    if (pendingReproduce) {
      pendingReproduceRef.current = null;
      requestReproduceRef.current(pendingReproduce);
    }
    if (teamSearchHandledRef.current) return;
    teamSearchHandledRef.current = true;
    const action = teamAssetActionFromSearch(search);
    if (!action) return;
    const rest = new URLSearchParams(search);
    rest.delete('team_asset');
    rest.delete('team_action');
    const query = rest.toString();
    setLocation(query ? `${location}?${query}` : location, { replace: true });
    teamAssetActionRef.current(action);
  }, [keysLoaded, search, location, setLocation]);

  const scopeRef = useRef(scopedId);
  scopeRef.current = scopedId;
  const latestJobs = useRef(persistedJobs);
  latestJobs.current = persistedJobs;
  const snapshotRequest = useRef(0);
  const refreshPersistedJobs = useCallback(async () => {
    const request = ++snapshotRequest.current;
    if (!scopedId) return;
    const atStart = new Map(latestJobs.current.map(job => [job.job_id, job]));
    const { jobs } = await listStudioAgentJobs(scopedId);
    if (scopeRef.current !== scopedId || request !== snapshotRequest.current) return;
    setPersistedJobs(current => {
      const incoming = new Map(jobs.map(job => [job.job_id, job]));
      const updated = current.filter(job => {
        if (jobSessionId(job) !== scopedId || atStart.get(job.job_id) === job) return false;
        incoming.delete(job.job_id);
        return true;
      });
      // 请求期间 SSE 带回的状态优先，已经删除的任务也不从旧快照复活。
      const retained = new Set(current.map(job => job.job_id));
      return [...updated, ...Array.from(incoming.values()).filter(job => !atStart.has(job.job_id) || retained.has(job.job_id))];
    });
  }, [scopedId]);
  const submissions = useMemo(() => {
    if (!session || session.session_id !== scopedId) return null;
    return session.turns.reduce((count, turn) => count + turn.steps.filter(step =>
      step.status === 'completed' && (step.tool === 'run_generation' || step.tool === 'run_generations'),
    ).length, 0);
  }, [session, scopedId]);
  const lastScope = useRef<{ id: typeof scopedId; submissions: number | null }>();
  useEffect(() => {
    const previous = lastScope.current;
    const switched = !previous || previous.id !== scopedId;
    const submitted = previous?.submissions != null && submissions != null && submissions > previous.submissions;
    lastScope.current = { id: scopedId, submissions };
    if (switched || submitted) void refreshPersistedJobs().catch(() => undefined);
  }, [scopedId, submissions, refreshPersistedJobs]);

  const handleJobChanged = useCallback((data: JobChangedPayload) => {
    if (!data.job_id) return;
    void getStudioJob(data.job_id).then(job => {
      if (job?.namespace === 'studio' && jobSessionId(job) === scopeRef.current) {
        setPersistedJobs(items => upsertJob(items, job));
      }
    }).catch(() => undefined);
  }, []);

  // 首屏已按会话加载；后续连接补齐断连期间漏掉的事件。
  useSSE({
    onStudioAgent: composer.agent.onAgentEvent,
    onJobChanged: handleJobChanged,
    onConnect: reconnected => {
      composer.agent.onReconnect();
      if (reconnected) void refreshPersistedJobs().catch(() => undefined);
    },
  });

  // SSE 兜底轮询：系统代理（Clash/V2Ray 的 TUN/全局模式）会把 127.0.0.1 的流式响应整条缓冲，
  // 心跳字节也被憋住，浏览器连接看着"正常开着"、永不 onerror、永不重连 —— 出图完成后前端卡
  // "生成中"直到手刷（普通 GET 不走流式缓冲，所以手刷能出）。#18 砍掉常驻 2s 轮询让 SSE 成
  // 唯一命脉，放大了这个脆弱点。这里只要还有 pending 轮次就每 4s 全量拉一次（= 自动帮用户手刷），
  // 出完自动翻面；无 pending 不轮询，保留 #18 的初衷。
  const hasPendingRound = scopedJobs.some(job => job.status === 'pending') || rounds.some(r => r.kind === 'pending');
  useEffect(() => {
    if (!hasPendingRound) return;
    const timer = setInterval(() => { void refreshPersistedJobs().catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [hasPendingRound, refreshPersistedJobs]);

  useEffect(() => {
    let cancelled = false;
    // 路由列表读失败只是没有「自动」项，不影响按 KEY 选模型。
    // TokenDance 价格快照与密钥一起就绪，首屏费用预估才不会先显示未计价。
    Promise.all([listKeys(), listModelRoutes().catch(() => [] as ModelRoute[]), loadTokenDancePrices()])
      .then(([resp, loadedRoutes]) => {
        if (cancelled) return;
        const usable = resp.keys.filter((key) => key.enabled !== false && key.models.length > 0);
        setKeys(usable);
        setRoutes(loadedRoutes);
        const choices = withAutoProvider(usable, loadedRoutes);
        // 优先恢复上次保存的供应商/模型（校验仍存在），否则回落到第一项（有路由时是「自动」）。
        const wantedAlias = draft?.providerAlias || saved.providerAlias;
        const wantedModel = draft?.model || saved.model;
        const savedKey = wantedAlias
          ? choices.find((key) => key.alias === wantedAlias)
          : undefined;
        const selected = savedKey ?? choices[0];
        setProviderAlias(selected?.alias ?? '');
        const savedModelValid = wantedModel && selected?.models.some((m) => m.id === wantedModel);
        // 没有可恢复的模型时取本类第一个；该 key 没有本类模型就先占一个，交给收敛 effect 换 key。
        const nextModel = savedModelValid
          ? wantedModel!
          : modelsForKind(selected, kind)[0]?.id ?? selected?.models[0]?.id ?? '';
        setModel(nextModel);
        setKeysLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setKeys([]);
        setKeysLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // saved 是首帧读到的存档快照，这条 effect 只在挂载时跑一次。把 saved.* 列进依赖会让它在
    // 用户改动写回存档后重跑，用旧值覆盖刚做的选择 —— 恢复必须是一次性的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 持久化供应商/模型/尺寸/张数等全部选择，切页面再回来时恢复。providerAlias 为空说明 keys 还没加载完，先不写。
  useEffect(() => {
    if (!providerAlias) return;
    saveSelection({
      providerAlias, model, sizeParams, count, quality,
      kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, sizeParams, count, quality,
    kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);

  async function submissionSession(prompt: string) {
    if (scopedId) return scopedId;
    const created = await composer.agent.createSession(Array.from(prompt.trim()).slice(0, 40).join('') || '新对话');
    return created.session_id;
  }

  const onSubmit = async (
    prompt: string, overrideConfig?: RoundConfig, promptTemplate?: string, reattachJobId?: string,
    overrideFiles?: SubmissionFiles, requestId?: string,
  ) => {
    const wantVideo = overrideConfig ? overrideConfig.kind === 'video' : kind === 'video';
    if (wantVideo) {
      await onSubmitVideo(prompt, overrideConfig, promptTemplate, reattachJobId, overrideFiles, requestId);
      return;
    }
    const effectiveAlias = overrideConfig?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? model;
    const selectedKey = providers.find((item) => item.alias === effectiveAlias);
    // 「自动」按组内第一个成员归一尺寸、估价；能力取全部成员的交集。
    const channel = resolveChannel(keys, selectedKey, effectiveModel);
    const size = sizeContext(providers, selectedKey, effectiveModel);
    const effectiveProvider = channel.key?.provider ?? overrideConfig?.provider;
    // 能力按模型族判；provider 只在 openrouter 上改 size 语义（比例串而非像素）。
    const caps = selectedKey ? size.caps : imageControlCaps(effectiveModel, effectiveProvider, undefined);
    // MJ 一次 imagine 固定回 4 张方案，张数不由画师定（见 MJ_IMAGES_PER_TASK）。
    const effectiveCount = caps.family === 'midjourney'
      ? MJ_IMAGES_PER_TASK
      : Math.min(caps.maxCount ?? 4, clampImageCount(overrideConfig?.n ?? count));
    const rawSizeParams: JobParams = overrideConfig
      ? { workflow_inputs: overrideConfig.workflowInputs, size_mode: overrideConfig.sizeMode ?? 'ratio', size: overrideConfig.size, ratio: overrideConfig.ratio, resolution: overrideConfig.resolution }
      : sizeParams;
    const preparedSize = prepareImageSizeSubmission(size.modelId, effectiveProvider, size.baseUrl, rawSizeParams, caps);
    if (preparedSize.error) {
      setAssetNotice(preparedSize.error);
      return;
    }
    const effectiveSizeParams = preparedSize.params!;
    const effectiveMode = imageSizeMode(effectiveSizeParams);
    if (effectiveMode === 'custom' && !overrideConfig) {
      setSizeParams(previous => ({ ...previous, size: effectiveSizeParams.size, custom_size: effectiveSizeParams.size }));
    }
    const effectiveSize = effectiveSizeParams.size;
    const effectiveRatio = effectiveMode === 'ratio' ? effectiveSizeParams.ratio : undefined;
    const effectiveResolution = effectiveMode === 'ratio' ? effectiveSizeParams.resolution as RoundConfig['resolution'] : undefined;
    // 质量档位只在该族真有时才发：seedream / dall-e 不认 low|high，nano-banana 不认 auto。
    const rawQuality = overrideConfig?.quality ?? quality;
    const effectiveQuality = caps.qualities?.includes(rawQuality) ? rawQuality : undefined;
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);
    const evoMj = isEvolinkMidjourney(channel.modelId, effectiveProvider);
    const rawMjParams = overrideConfig?.mjParams ?? mjParams;
    const effectiveMjParams = evoMj ? evolinkMjParams(rawMjParams) : rawMjParams;
    const effectiveSourceAssetTitle = overrideConfig
      ? overrideConfig.sourceAssetTitle
      : promptAssetSourceTitle ?? undefined;

    setPending(true);
    // 这次提交意图的请求 ID：受理未知后重试沿用它，服务端同 ID 只建一个任务。
    const clientRequestId = requestId ?? newStudioRequestId();
    const submittedInput = overrideConfig ? null : editorRef.current.input;
    let sessionId: string;
    try {
      sessionId = await submissionSession(prompt);
    } catch (error) {
      setAssetNotice(errorText(error));
      setPending(false);
      return;
    }
    // 提交前把参考图 File[] 上传到 .runtime/uploads/，拿到服务器路径写进 params.reference_images。
    // 再次生成（overrideConfig）携带的已是服务器路径，直接复用；本地失败卡的再次生成带着当时的文件重新上传。
    // 超出本模型上限的参考留在输入里（置灰），只发前 N 张。
    const files: SubmissionFiles = overrideFiles ?? {
      images: referenceImages.slice(0, caps.maxRefImages ?? maxReferenceImages(effectiveModel)),
      mjRefs, frames: null, videos: [], audios: [],
    };
    const uploadsFiles = !overrideConfig || Boolean(overrideFiles);
    const baseConfig: RoundConfig = {
      prompt, alias: effectiveAlias, provider: effectiveProvider, model: effectiveModel,
      modelName: selectedModel?.name ?? overrideConfig?.modelName,
      ratio: effectiveRatio, resolution: caps.showResolution ? effectiveResolution : undefined,
      size: effectiveSize, sizeMode: effectiveMode, n: effectiveCount, quality: effectiveQuality,
      referenceImages: overrideConfig && !overrideFiles ? overrideConfig.referenceImages : [],
      ...(caps.family === 'midjourney' ? { mjParams: effectiveMjParams } : {}),
    };
    const startedAt = Date.now();
    const clientKey = `local-${crypto.randomUUID()}`;
    // 先放占位卡再上传：大参考上传期间历史区就有反馈，失败时这张卡原地变成失败卡。
    const placeholder = {
      kind: 'pending' as const, sessionId, startedAt, config: baseConfig, clientKey,
      uploading: uploadsFiles && hasFiles(files),
    };
    setRounds((rs) => [placeholder, ...rs]);
    scrollToBottom();
    let refPaths: string[];
    let mjRefPaths: { sref?: string[]; cref?: string[]; oref?: string[] } = {};
    try {
      ({ referenceImages: refPaths, mjRefPaths } = await resolveImageReferencePaths({
        midjourney: caps.family === 'midjourney', referenceImages: files.images,
        mjRefs: evoMj ? { ...files.mjRefs, cref: [], oref: [] } : files.mjRefs,
        overrideReferenceImages: uploadsFiles ? undefined : overrideConfig?.referenceImages,
        overrideMjRefPaths: uploadsFiles ? undefined : evoMj && overrideConfig?.mjRefPaths
          ? { sref: overrideConfig.mjRefPaths.sref } : overrideConfig?.mjRefPaths,
        srefCodeActive: hasSrefCode(effectiveMjParams),
      }));
    } catch (e) {
      failLocally(placeholder, baseConfig, e, { files });
      return;
    }

    const config: RoundConfig = {
      prompt,
      alias: effectiveAlias,
      provider: effectiveProvider,
      model: effectiveModel,
      modelName: selectedModel?.name ?? overrideConfig?.modelName,
      ratio: effectiveRatio,
      resolution: caps.showResolution ? effectiveResolution : undefined,
      size: effectiveSize,
      sizeMode: effectiveMode,
      n: effectiveCount,
      quality: effectiveQuality,
      ...gptImage26JobParams(caps, overrideConfig ?? effectiveSizeParams, refPaths.length > 0),
      referenceImages: refPaths,
      workflowInputs: effectiveSizeParams.workflow_inputs,
      ...(effectiveSourceAssetTitle ? { sourceAssetTitle: effectiveSourceAssetTitle } : {}),
      ...(caps.family === 'midjourney'
        ? { mjParams: effectiveMjParams, mjRefPaths }
        : {}),
    };
    // 控件隐藏的参数一律不写进 params（与视频侧同写法）：后端 openrouter_image 会把
    // params.resolution 原样当 API 参数发出去，在别的 key 上选过 4K 就会被带过来按 4K 计费。
    const jobParams: JobParams = {
      ...(effectiveProvider === 'comfyui' ? { workflow_inputs: effectiveSizeParams.workflow_inputs } : {}),
      ...(caps.ratios.length || caps.showCustomSize || caps.showAutoSize ? { size_mode: effectiveMode } : {}),
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(effectiveRatio ? { ratio: effectiveRatio } : {}),
      ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { quality: effectiveQuality } : {}),
      ...gptImage26JobParams(caps, overrideConfig ?? effectiveSizeParams, refPaths.length > 0),
      ...(refPaths.length > 0 ? { reference_images: refPaths } : {}),
      ...(effectiveSourceAssetTitle
        ? { creation_asset_source_title: effectiveSourceAssetTitle }
        : {}),
      // MJ 的一切控制都在 prompt flag 里，由后端 mj_image 拼接；这里只发结构化值。
      ...(caps.family === 'midjourney'
        ? {
            ...mjParamsToJob(effectiveMjParams),
            ...(mjRefPaths.sref ? { mj_sref: mjRefPaths.sref } : {}),
            ...(mjRefPaths.cref ? { mj_cref: mjRefPaths.cref } : {}),
            ...(mjRefPaths.oref ? { mj_oref: mjRefPaths.oref } : {}),
          }
        : {}),
    };
    const estimatedCost = estimateGenerationCostForSubmission(
      channel.key,
      channel.modelId,
      'image',
      jobParams,
    );
    if (estimatedCost != null && effectiveMode !== 'auto') jobParams.estimated_cost_cny = estimatedCost;

    const myRound = { kind: 'pending' as const, sessionId, startedAt, config, clientKey };
    setRounds((rs) => rs.map(r => r === placeholder ? myRound : r));

    let job: Job;
    try {
      job = await createStudioJob({
        studio_agent_session_id: sessionId,
        prompt,
        ...(promptTemplate ? { prompt_template: promptTemplate } : {}),
        alias: isAutoProvider({ alias: effectiveAlias }) ? undefined : effectiveAlias ?? undefined,
        model: effectiveModel,
        params: jobParams,
        ...(reattachJobId ? { reattach_job_id: reattachJobId } : {}),
        client_request_id: clientRequestId,
      });
    } catch (e) {
      failLocally(myRound, config, e, { requestId: clientRequestId });
      return;
    }
    if (submittedInput) markStudioInputSubmitted(sessionId, submittedInput);
    setPending(false);
    // 提交真正发出去了，复刻时的提示才算用完。
    setRecipeNotice(null);

    handoffs.current.set(job.job_id, { clientKey, startedAt });
    setPersistedJobs(items => items.some(item => item.job_id === job.job_id) ? items : [job, ...items]);
    setRounds(rs => rs.filter(r => r !== myRound));
  };

  const onSubmitVideo = async (
    prompt: string, overrideConfig?: RoundConfig, promptTemplate?: string, reattachJobId?: string,
    overrideFiles?: SubmissionFiles, requestId?: string,
  ) => {
    // 切到视频后 PromptInput 只是按模型分类过滤显示，父级 providerAlias/model 不一定已是视频 key——这里收敛。
    const videoModelsOf = (k: KeyView) => (k.models ?? []).filter((m) => modelModality(m, k) === 'video');
    const videoKeys = providers.filter((item) => videoModelsOf(item).length > 0);
    const selectedKey =
      (overrideConfig?.alias ? providers.find((item) => item.alias === overrideConfig.alias) : undefined)
      ?? videoKeys.find((item) => item.alias === providerAlias)
      ?? videoKeys[0];
    const selectedVideoModels = selectedKey ? videoModelsOf(selectedKey) : [];
    const effectiveAlias = overrideConfig?.alias ?? selectedKey?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model
      ?? (selectedVideoModels.some((m) => m.id === model) ? model : selectedVideoModels[0]?.id)
      ?? model;
    const channel = resolveChannel(keys, selectedKey, effectiveModel);
    const effectiveProvider = channel.key?.provider ?? overrideConfig?.provider;
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);
    // 协议由后端按模型 id/供应商自动判定（read_keys_db 回填）；前端只在已知时用它精化 caps。
    const effectiveCaps = videoControlCaps(channel.modelId, selectedModel?.protocol, selectedModel?.declared);

    setPending(true);
    // 这次提交意图的请求 ID：受理未知后重试沿用它，服务端同 ID 只建一个任务。
    const clientRequestId = requestId ?? newStudioRequestId();
    const submittedInput = overrideConfig ? null : editorRef.current.input;
    let sessionId: string;
    try {
      sessionId = await submissionSession(prompt);
    } catch (error) {
      setAssetNotice(errorText(error));
      setPending(false);
      return;
    }
    // 视频/音频参考图复用通用文件上传端点（Task 1 已放开 video/audio）。override 携带的已是服务器路径，直接复用。
    let imgPaths: string[];
    let vidPaths: string[];
    let audPaths: string[];
    // 首尾帧模式上传的是显式双槽（可只有尾帧）；全能参考模式才用 referenceImages 列表。
    // 槽位按 caps.maxFrames 截断：t2v(0) 不传任何帧、i2v(1) 只收首帧——防换模型后残留旧槽文件。
    const firstFrame = effectiveCaps.maxFrames >= 1 ? videoFrames.first : null;
    const lastFrame = effectiveCaps.maxFrames >= 2 ? videoFrames.last : null;
    const frameFiles = videoMode === 'firstlast'
      ? [firstFrame, lastFrame].filter((f): f is File => f !== null)
      : null;
    // 超出上限的参考留在输入里（置灰），只发前 N 张。
    const files: SubmissionFiles = overrideFiles ?? {
      images: referenceImages.slice(0, effectiveCaps.maxRefImages ?? MAX_REF_IMAGES), mjRefs: EMPTY_MJ_REFS,
      frames: frameFiles, videos: referenceVideos, audios: referenceAudios,
    };
    const uploadsFiles = !overrideConfig || Boolean(overrideFiles);
    const upload = (list: File[]) => list.length > 0 ? Promise.all(list.map(uploadReferenceImage)) : Promise.resolve([]);
    const baseConfig: RoundConfig = {
      prompt, kind: 'video', alias: effectiveAlias, provider: effectiveProvider, model: effectiveModel,
      modelName: selectedModel?.name ?? overrideConfig?.modelName,
      ratio: overrideConfig?.ratio ?? videoRatio, n: clampImageCount(overrideConfig?.n ?? videoCount),
      duration: overrideConfig?.duration ?? duration,
      videoSeed: overrideConfig ? overrideConfig.videoSeed : videoSeed,
      referenceImages: uploadsFiles ? [] : overrideConfig?.referenceImages ?? [],
    };
    const startedAt = Date.now();
    const clientKey = `local-${crypto.randomUUID()}`;
    const placeholder = {
      kind: 'pending' as const, sessionId, startedAt, config: baseConfig, clientKey,
      uploading: uploadsFiles && hasFiles(files),
    };
    setRounds((rs) => [placeholder, ...rs]);
    scrollToBottom();
    try {
      imgPaths = !uploadsFiles && overrideConfig?.referenceImages
        ? overrideConfig.referenceImages
        : await upload(files.frames ?? files.images);
      vidPaths = !uploadsFiles && overrideConfig?.referenceVideos ? overrideConfig.referenceVideos : await upload(files.videos);
      audPaths = !uploadsFiles && overrideConfig?.referenceAudios ? overrideConfig.referenceAudios : await upload(files.audios);
    } catch (e) {
      failLocally(placeholder, baseConfig, e, { files });
      return;
    }

    // 再次生成（overrideConfig）完整还原原 job 的视频参数，而不是回落到当前表单态。
    const effectiveDuration = overrideConfig?.duration ?? duration;
    // kling 等无分辨率参数的族不发 resolution；override 路径按原 job 是否带过该参数还原。
    const effectiveResolution = overrideConfig
      ? overrideConfig.videoResolution
      : (effectiveCaps.resolutions.length > 0 ? videoResolution : undefined);
    const effectiveRatio = overrideConfig?.ratio ?? videoRatio;
    // kling 档位（params.mode std/pro）：仅支持档位的族才发。
    const effectiveQuality = overrideConfig
      ? overrideConfig.videoQuality
      : (effectiveCaps.qualities ? videoQuality : undefined);
    const effectiveCount = clampImageCount(overrideConfig?.n ?? videoCount);
    const effectiveSourceAssetTitle = overrideConfig
      ? overrideConfig.sourceAssetTitle
      : promptAssetSourceTitle ?? undefined;
    // frame_mode 不再是用户选项：首尾帧模式按双槽推导（双帧→firstlast、仅首→first、仅尾→last、
    // 全空→省略 = 文生视频）；全能参考模式不发 frame_mode（全部按 reference_image 角色）。
    const effectiveFrameMode = overrideConfig
      ? overrideConfig.frameMode
      : (videoMode === 'firstlast'
          ? (firstFrame && lastFrame ? 'firstlast'
            : firstFrame ? 'first'
            : lastFrame ? 'last'
            : undefined)
          : undefined);
    const effectiveGenerateAudio = overrideConfig ? !!overrideConfig.generateAudio : generateAudio;

    // duration / ratio 仅在该族确有此参数时写入（happyhorse video-edit 随输入、i2v 比例随首帧）。
    const videoParams: JobParams = {
      ...(baseConfig.videoSeed != null ? { seed: baseConfig.videoSeed } : {}),
      ...(effectiveCaps.durations.length > 0 ? { duration: effectiveDuration } : {}),
      ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
      ...(effectiveCaps.ratios.length > 0 ? { ratio: effectiveRatio } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { mode: effectiveQuality } : {}),
      ...(effectiveFrameMode ? { frame_mode: effectiveFrameMode } : {}),
      // 上游 generate_audio 默认 true（2.0 系），关闭也必须显式发 false，省略字段≠关闭。
      ...(effectiveCaps.supportsAudio ? { generate_audio: effectiveGenerateAudio } : {}),
      ...(imgPaths.length ? { reference_images: imgPaths } : {}),
      ...(vidPaths.length ? { reference_videos: vidPaths } : {}),
      ...(audPaths.length ? { reference_audios: audPaths } : {}),
      ...(effectiveSourceAssetTitle
        ? { creation_asset_source_title: effectiveSourceAssetTitle }
        : {}),
    };
    const estimatedCost = estimateGenerationCostForSubmission(
      channel.key,
      channel.modelId,
      'video',
      videoParams,
    );
    if (estimatedCost != null) videoParams.estimated_cost_cny = estimatedCost;

    const config: RoundConfig = {
      prompt,
      kind: 'video',
      alias: effectiveAlias,
      provider: effectiveProvider,
      model: effectiveModel,
      modelName: selectedModel?.name ?? overrideConfig?.modelName,
      ratio: effectiveRatio,
      n: effectiveCount,
      duration: effectiveDuration,
      videoResolution: effectiveResolution,
      videoQuality: effectiveQuality,
      frameMode: effectiveFrameMode,
      generateAudio: effectiveGenerateAudio,
      videoSeed: baseConfig.videoSeed,
      referenceImages: imgPaths,
      referenceVideos: vidPaths,
      referenceAudios: audPaths,
      ...(effectiveSourceAssetTitle ? { sourceAssetTitle: effectiveSourceAssetTitle } : {}),
    };

    const myRound = { kind: 'pending' as const, sessionId, startedAt, config, clientKey };
    setRounds((rs) => rs.map(r => r === placeholder ? myRound : r));

    let job: Job;
    try {
      job = await createStudioJob({
        studio_agent_session_id: sessionId,
        prompt,
        ...(promptTemplate ? { prompt_template: promptTemplate } : {}),
        alias: isAutoProvider({ alias: effectiveAlias }) ? undefined : effectiveAlias ?? undefined,
        model: effectiveModel,
        params: videoParams,
        kind: 'video',
        ...(reattachJobId ? { reattach_job_id: reattachJobId } : {}),
        client_request_id: clientRequestId,
      });
    } catch (e) {
      failLocally(myRound, config, e, { requestId: clientRequestId });
      return;
    }
    if (submittedInput) markStudioInputSubmitted(sessionId, submittedInput);
    setPending(false);
    setRecipeNotice(null);

    handoffs.current.set(job.job_id, { clientKey, startedAt });
    setPersistedJobs(items => items.some(item => item.job_id === job.job_id) ? items : [job, ...items]);
    setRounds(rs => rs.filter(r => r !== myRound));
  };

  // 提交前就失败：占位卡原地变成失败卡，带着配置与客户端 id，可删、可重新编辑。分三种：
  // 上传参考失败（留下当时的文件，「再次生成」重新上传）、服务端明确拒绝（没建任务）、
  // 受理未知（回包途中断开，任务可能已建）——最后一种不给「再次生成」，先按请求 ID 核对。
  const localSubmissionFiles = useRef(new Map<string, SubmissionFiles>());
  const localRequestIds = useRef(new Map<string, string>());
  function failLocally(
    round: RoundState & { sessionId: string; clientKey: string }, config: RoundConfig, error: unknown,
    { files, requestId }: { files?: SubmissionFiles; requestId?: string },
  ) {
    const clientKey = round.clientKey;
    if (files) localSubmissionFiles.current.set(clientKey, files);
    const unknown = Boolean(requestId) && !submissionRejected(error);
    if (unknown && requestId) localRequestIds.current.set(clientKey, requestId);
    setSubmitFailures(count => count + 1);
    setPending(false);
    const message = errorText(error, '生成没有提交成功');
    const failure: RoundFailure = files
      ? { message: `参考素材上传失败：${message}`, action: { label: '重试', kind: 'retry' } }
      : unknown
        ? { message: '没有收到 Cobrush 的确认，这次生成可能已经提交', action: { label: '重新查询', kind: 'requery' } }
        : { message };
    setRounds(rs => rs.map(r => r === round ? {
      kind: 'failed' as const, sessionId: round.sessionId, clientKey, submittedAt: new Date().toISOString(),
      reason: error instanceof Error ? error.message : message, config, failure,
    } : r));
  }

  // 受理未知的本地失败卡：按请求 ID 查到任务就接上它（卡片原地换成这一轮），查不到才允许重新提交。
  function adoptSubmittedJob(job: Job, clientKey: string) {
    localRequestIds.current.delete(clientKey);
    localSubmissionFiles.current.delete(clientKey);
    handoffs.current.set(job.job_id, { clientKey, startedAt: Date.parse(job.submitted_at) || Date.now() });
    setPersistedJobs(items => upsertJob(items, job));
    setRounds(rs => rs.filter(r => r.clientKey !== clientKey));
  }

  /** 返回 true = 已接上原任务；false = 服务端确认没收到；null = 核对本身失败（状态仍未知）。 */
  async function reconcileLocalSubmission(clientKey: string): Promise<boolean | null> {
    const requestId = localRequestIds.current.get(clientKey);
    if (!requestId) return false;
    let job: Job | null;
    try {
      job = await findStudioJobByRequest(requestId);
    } catch (error) {
      notify.error(errorText(error, '核对提交结果失败'));
      return null;
    }
    if (!job) return false;
    adoptSubmittedJob(job, clientKey);
    return true;
  }

  async function recheckLocalSubmission(clientKey: string) {
    if (await reconcileLocalSubmission(clientKey) !== false) return;
    // 服务端确认没收到：这时再提交不会重复下单（仍沿用同一请求 ID）。
    setRounds(rs => rs.map(r => r.clientKey === clientKey && r.kind === 'failed' ? {
      ...r, failure: { message: 'Cobrush 没有收到这次提交', action: { label: '重试', kind: 'retry' } },
    } : r));
  }

  async function requeryRound(jobId: string) {
    try {
      const job = await requeryStudioJob(jobId);
      setPersistedJobs(items => upsertJob(items, job));
    } catch (error) {
      notify.error(errorText(error, '重新查询失败'));
    }
  }

  const renderRounds = (items: TimelineRound[], embedded = false): React.ReactNode => (
        <RoundList
          key={scopedId}
          rounds={items} embedded={embedded}
          renderAgent={entry => session && <StudioAgentTurnCard turn={entry.turn} session={session}
            agent={composer.agent} messages={entry.messages} jobs={entry.jobs}
            renderJobs={jobs => renderRounds(studioJobsToRounds(jobs, keys, 'asc'), true)}
            last={!pending && !hasHistoryFilters(historyFilters) && timeline.at(-1) === entry}
            onRetry={() => void retryAgentTurn(entry.turn, entry.messages)}
            onPickSuggestion={text => {
              composer.switchMode('agent');
              composer.setText(text);
              setClickPinned(true);
              composer.editor.current?.focus();
            }} />}
          focusJobId={targetJobId ?? undefined}
          focusHighlight={focusHighlight}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          hiddenPaths={hiddenPaths}
          onToggleHidden={toggleHidden}
          onDeleteFailed={deleteFailedRound}
          onDismissLocal={dismissLocalRound}
          onCancel={cancelRound}
          onReEdit={(config, id) => { return reEdit(config, id); }}
          onUsePrompt={usePrompt}
          reuseParameter={reuseParameter}
          onRegenerate={regenerate}
          regenerateHint={regenerateHint}
          onDeleteBatch={jobId => trashRound(jobId)}
          onDeleteResult={(jobId, path) => trashRound(jobId, path)}
          onFailureAction={handleFailureAction}
          canvasTargets={roundCanvasOptions}
          onAddToCanvas={addResultToCanvas}
          onReuseReferences={embedded ? undefined : handleReuseReferences}
          onEditAsReference={handleEditAsReference}
          onShareResult={(jobId, index, path, config) => setShareRequest({
            source: { kind: 'job_output', job_id: jobId, output_index: index },
            defaultTitle: assetTitleFromPrompt(config.prompt),
            // 对话框只把 previewUrl 渲染成 <img>：视频结果不传。
            ...(config.kind === 'video' ? {} : { previewUrl: galleryMediaUrl(path) }),
          })}
          onSavePromptAsset={(config) => {
            setAssetPanelKind('prompt');
            setAssetPanelOpen(true);
            setAssetSaveRequest({
              requestId: crypto.randomUUID(),
              kind: 'prompt',
              title: assetTitleFromPrompt(config.prompt),
              segments: [{ kind: 'text', text: config.prompt }],
            });
          }}
          onSaveResultAsset={saveResultAsset}
        />
  );

  return (
    <div
      className="relative h-full overflow-hidden px-3 sm:px-6"
      aria-label="生图沙箱"
    >
      {sharedAuth && <SharedCanvasPasscodeDialog peerKey={sharedAuth.target.peer_key}
        projectId={sharedAuth.target.project_id} name={sharedAuth.target.name} needsName={sharedAuth.needsName}
        needsCode={sharedAuth.target.requires_passcode} onClose={() => setSharedAuth(null)} onEntered={() => {
          const { jobId, index, target } = sharedAuth;
          setSharedAuth(null);
          void shareStudioResult(jobId, index, target.peer_key, target.project_id)
            .then(() => setAssetNotice(`已加入画布「${clipName(target.name)}」`)).catch(e => notify.error(errorText(e)));
        }} />}
      {/* 查询条：固定顶部覆盖层，不随历史滚动。wrapper 不收事件，条本体 pointer-events-auto。 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1024px] items-center justify-between gap-2">
          <StudioSessionControls agent={composer.agent} disabled={pending} />
          <StudioQueryBar filters={historyFilters} onChange={setHistoryFilters} />
        </div>
      </div>
      {/* col-reverse：浏览器原生钉底，scrollTop 0 即底部；rounds 反转后最新一轮落在视觉底部。
          pt 让出查询条空间，pb 预留输入壳展开高度，最后一轮不被浮层压住。 */}
      <div
        ref={scrollRef}
        onScroll={handleHistoryScroll}
        data-studio-history-scroll
        data-testid="studio-history-scroll"
        className="scroll-fade-t flex h-full flex-col-reverse overflow-y-auto [scrollbar-gutter:stable_both-edges] pt-20 pb-64"
      >
        {usage && visibleRounds.length > 0 && <div className="mx-auto w-full max-w-[1024px] pt-4">
          <Hint label={usage.detail}><span className="text-xs text-muted-foreground">{usage.text}</span></Hint>
        </div>}
        {!timeline.length
          ? <p className="my-auto text-center font-display text-display italic text-foreground/70">今天想一起创作什么？</p>
          : visibleRounds.length ? renderRounds(visibleRounds)
            : <FilteredEmpty />}
      </div>
      {/* 浮层输入：wrapper 不收事件，两侧视觉与交互都穿透到历史区；壳本体在 PromptInput 内
          pointer-events-auto。 */}
      <div ref={dockRef} className="pointer-events-none absolute inset-x-0 bottom-4 px-3 sm:px-6">
        <div className="relative mx-auto flex max-w-[844px] items-end gap-3 lg:max-w-[780px]">
          <div className="relative min-w-0 flex-1">
          {/* 回到底部：常驻挂载才有进出动画。锚定 bottom-full 让它跟着壳顶升降——
              壳展开时被顶着上移、同时向右上平移渐隐；收起时反向浮现。 */}
          <Button variant="bare"
            type="button"
            onClick={scrollToBottom}
            tabIndex={dockCollapsed ? 0 : -1}
            aria-hidden={!dockCollapsed}
            className={`absolute bottom-full right-0 mb-3 inline-flex h-8 items-center gap-1 rounded-full border border-border bg-glass backdrop-blur-glass px-3 text-xs text-foreground transition-[opacity,translate,background-color] duration-300 ease-in-out hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              dockCollapsed
                ? 'pointer-events-auto opacity-100 translate-x-0 translate-y-0'
                : 'pointer-events-none opacity-0 translate-x-3 -translate-y-2'
            }`}
          >
            <ScrollBottomIcon size="sm" aria-hidden />
            回到底部
          </Button>
        {/* 提示条贴着输入壳上沿：出现时从下方 4px 淡入（150ms），消失时原位淡出，不硬切。 */}
        <div className="absolute bottom-full left-0 mb-2 flex flex-col items-start gap-1">
          <AnimatePresence initial={false}>
          {replacedInput && (
            <motion.div
              key="replaced"
              {...NOTICE_MOTION}
              role="status"
              data-testid="studio-replaced-notice"
              onMouseEnter={() => setReplacedPaused(true)}
              onMouseLeave={() => setReplacedPaused(false)}
              className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              <span>已替换当前输入</span>
              <Button variant="link" size="sm" type="button" onClick={undoReplace}
                className="h-auto p-0 text-xs text-primary">撤销</Button>
            </motion.div>
          )}
          {overLimit && (
            <motion.span
              key="over-limit"
              {...NOTICE_MOTION}
              role="status"
              data-testid="studio-over-limit-notice"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              本模型只用前 {imageReferenceLimit} 张参考图
            </motion.span>
          )}
          {recipeNotice && (
            <motion.div
              key="recipe"
              {...NOTICE_MOTION}
              role="status"
              data-testid="studio-recipe-notice"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              {recipeNotice.missingModel && <p>本机没有 {recipeNotice.missingModel}</p>}
              {recipeNotice.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </motion.div>
          )}
          {assetNotice && (
            <motion.span
              key="asset"
              {...NOTICE_MOTION}
              role="status"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              {assetNotice}
            </motion.span>
          )}
          {reuseLimitNotice && (
            <motion.span
              key="reuse-limit"
              {...NOTICE_MOTION}
              role="status"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              历史参考图超过 MJ 每槽 4 张，已保留前 4 张
            </motion.span>
          )}
          </AnimatePresence>
        </div>
        <StudioComposer state={composer}
          submitErrorKey={submitFailures || null}
          flashRequest={inputFlash}
          collapsed={dockCollapsed}
          onExpandRequest={() => setClickPinned(true)}
          onShellFocusChange={setShellFocused}
          onSubmit={(prompt, template) => onSubmit(prompt, undefined, template)}
          estimateLabel={estimateLabel}
          onNotice={setAssetNotice}
          onOpenProviders={() => setLocation('/settings/providers')}
          disabled={pending || composer.agent.pending || composer.agent.waitingForSession}
          value={promptText}
          onValueChange={setPromptText}
          onSavePromptAsset={() => {
            setAssetPanelKind('prompt');
            setAssetPanelOpen(true);
            setAssetSaveRequest({
              requestId: crypto.randomUUID(),
              kind: 'prompt',
              segments: promptToAssetSegments(promptText),
            });
          }}
          assetPanelOpen={assetPanelOpen}
          onToggleAssetPanel={() => {
            if (assetPanelOpen) assetPanelRef.current?.requestClose();
            else setAssetPanelOpen(true);
          }}
          providers={providers}
          providerAlias={providerAlias}
          model={model}
          sizeParams={sizeParams}
          onSizeParamsChange={handleSizeParamsChange}
          count={count}
          quality={quality}
          mjParams={mjParams}
          onMjParamsChange={(patch) => setMjParams((prev) => ({ ...prev, ...patch }))}
          mjRefs={mjRefs}
          onMjRefsChange={setMjRefs}
          onProviderChange={alias => {
            setProviderAlias(alias);
            setSizeParams(previous => imageSizeMode(previous) === 'ratio' ? { ...previous, size: undefined } : previous);
          }}
          onModelChange={next => {
            setModel(next);
            if (next) setRecipeNotice(current => withoutMissingModel(current));
            setSizeParams(previous => imageSizeMode(previous) === 'ratio' ? { ...previous, size: undefined } : previous);
          }}
          onCountChange={setCount}
          onQualityChange={setQuality}
          menuDirection="up"
          referenceImages={referenceImages}
          onReferenceImagesChange={setReferenceImages}
          videoMode={videoMode}
          videoCaps={videoCaps}
          duration={duration}
          videoResolution={videoResolution}
          videoRatio={videoRatio}
          videoQuality={videoQuality}
          videoCount={videoCount}
          videoSeed={videoSeed}
          onClearVideoSeed={() => setVideoSeed(undefined)}
          generateAudio={generateAudio}
          onVideoModeChange={setVideoMode}
          onDurationChange={setDuration}
          onVideoResolutionChange={setVideoResolution}
          onVideoRatioChange={setVideoRatio}
          onVideoQualityChange={setVideoQuality}
          onVideoCountChange={setVideoCount}
          onGenerateAudioChange={setGenerateAudio}
          referenceVideos={referenceVideos}
          referenceAudios={referenceAudios}
          onReferenceVideosChange={setReferenceVideos}
          onReferenceAudiosChange={setReferenceAudios}
          videoFrames={videoFrames}
          onVideoFramesChange={setVideoFrames}
        />
          </div>
        </div>
      </div>
      {assetPanelOpen && (
        <CreationAssetPanel
          key={assetPanelMount}
          ref={assetPanelRef}
          initialKind={assetPanelKind}
          initialTeamProjectId={teamPanelTarget?.projectId}
          initialTeamLibraryId={teamPanelTarget?.libraryId}
          canvasTargets={canvasTargetOptions}
          saveRequest={assetSaveRequest}
          onSaveRequestHandled={(requestId) => {
            setAssetSaveRequest(current => current?.requestId === requestId ? null : current);
          }}
          onClose={() => {
            setAssetPanelOpen(false);
            setTeamPanelTarget(null);
          }}
          onUsePrompt={(asset, renderedPrompt) => {
            if (composer.mode === 'agent') { composer.setText(renderedPrompt); return; }
            setPromptText(renderedPrompt);
            sourceTitleFile.current = null;
            setPromptAssetSourceTitle(asset.title);
            setClickPinned(true);
          }}
          onUseMedia={(asset, content) => { void addCreationAssetReference(asset, content); }}
          onReproduce={requestReproduce}
          onUseTeamMedia={(file, entry, key) => {
            const reused = teamReferenceFiles.current.get(key) ?? file;
            teamReferenceFiles.current.set(key, reused);
            addReferenceFile(reused, entry.mime_type ?? file.type, entry.title);
          }}
          onUseTeamPrompt={(text, entry) => {
            if (composer.mode === 'agent') { composer.setText(text); return; }
            setPromptText(text); sourceTitleFile.current = null; setPromptAssetSourceTitle(entry.title); setClickPinned(true);
          }}
        />
      )}
      <TeamShareDialog
        request={shareRequest}
        onClose={() => setShareRequest(null)}
        onShared={(_entry, libraryName) => setAssetNotice(`已分享到 ${libraryName}`)}
      />
    </div>
  );

  function hasEditorInput(): boolean {
    return Boolean(
      promptText.trim()
      || referenceImages.length
      || referenceVideos.length
      || referenceAudios.length
      || videoFrames.first
      || videoFrames.last
      || mjRefs.image.length
      || mjRefs.sref.length
      || mjRefs.cref.length
      || mjRefs.oref.length,
    );
  }

  // Studio 自家出图存成带配方的生成资产；skill / 归档来的记录后端不收 from-job，只存媒体。
  function saveResultAsset({ jobId, index, path, mediaKind, generated, config }: SaveResultAssetRequest) {
    setAssetPanelKind('media');
    setAssetPanelOpen(true);
    setAssetSaveRequest({
      requestId: crypto.randomUUID(),
      kind: 'media',
      title: assetTitleFromPrompt(config.prompt),
      sourcePath: path,
      previewUrl: galleryMediaUrl(path),
      mediaKind,
      ...(generated ? { source: { kind: 'job_output' as const, job_id: jobId, output_index: index } } : {}),
    });
  }

  // 复刻 = 先采用（从库到本机一律是采用；Studio 没有当前画布，不挂项目），再走资产复刻。
  async function handleTeamAssetAction(action: TeamAssetAction) {
    if (action.action === 'open') {
      await openTeamPanel(action.library_id);
      return;
    }
    try {
      const { asset } = await adoptTeamAsset(action.library_id, action.asset_id);
      // 与面板里的「复刻」一致：先记一次使用。
      requestReproduceRef.current(await markCreationAssetUsed(asset.asset_id));
    } catch (error) {
      setAssetNotice(errorText(error, '复刻失败'));
    }
  }

  // 团队栏挂在画布项目上：先拿到画布列表与挂着该库的画布再挂载面板，否则首帧没有项目会退回提示词栏。
  async function openTeamPanel(libraryId: string) {
    let projects: CanvasProject[];
    let projectId: string | undefined;
    try {
      const [canvases, mounts] = await Promise.all([
        listCanvasProjects(true),
        listTeamLibraries(),
      ]);
      projects = canvases;
      projectId = mounts.find(mount => mount.library_id === libraryId)?.project_id;
    } catch (error) {
      setAssetNotice(errorText(error, '读取团队库失败'));
      return;
    }
    if (!projectId || !projects.some(project => project.project_id === projectId)) {
      setAssetNotice('没有挂载这个团队库');
      return;
    }
    const target = { projectId, libraryId };
    const show = () => {
      setCanvasTargets(projects);
      setTeamPanelTarget(target);
      setAssetPanelKind('team');
      setAssetPanelMount(current => current + 1);
      setAssetPanelOpen(true);
    };
    if (assetPanelRef.current) assetPanelRef.current.requestTransition(show);
    else show();
  }

  // 复刻 = 把生成资产的配方填进当前输入框（同「重新编辑」），不自动提交；覆盖非空输入时给撤销，不弹确认。
  function requestReproduce(asset: CreationAsset) {
    // keys 未加载时判不出本机有没有配方模型，不能当成缺模型去填：先记下，加载完补做（为空则照常按缺模型填）。
    if (!keysLoaded) {
      pendingReproduceRef.current = asset;
      return;
    }
    void reproduce(asset);
  }

  async function reproduce(asset: CreationAsset) {
    if (asset.content.kind !== 'generation') return;
    const recipe = asset.content.snapshot;
    const requestSequence = ++reEditSequence.current;
    const recipeDraft = recipeToDraft(recipe, keys);
    setClickPinned(true);
    try {
      const fetchGroup = (inputs: RecipeInput[]) => Promise.all(
        inputs.map((input) => fetchRecipeInput(asset.asset_id, input)),
      );
      const { inputs } = recipeDraft;
      const [images, videos, audios, sref, cref, oref] = await Promise.all([
        fetchGroup(inputs.images),
        fetchGroup(inputs.videos),
        fetchGroup(inputs.audios),
        fetchGroup(inputs.mj.sref),
        fetchGroup(inputs.mj.cref),
        fetchGroup(inputs.mj.oref),
      ]);
      if (requestSequence !== reEditSequence.current) return;
      const before = snapshotIfFilled();
      applyRoundConfig(
        { ...recipeDraft.config, sourceAssetTitle: asset.title },
        { images, videos, audios, sref, cref, oref },
      );
      offerUndo(before);
      // 缺模型：alias 不动（配置里本就为空），模型位空着等用户选；MJ 参考分组仍按配方模型路由。
      if (!recipeDraft.model) setModel('');
      const warnings = recipeDraft.config.warnings ?? [];
      const missingModel = recipeDraft.model ? null : recipe.model;
      setRecipeNotice(missingModel || warnings.length > 0 ? { missingModel, warnings } : null);
    } catch (error) {
      if (requestSequence !== reEditSequence.current) return;
      setAssetNotice(errorText(error, '参考素材恢复失败'));
    }
  }

  function mediaReferenceRoute(mime: string, empty = false): ReturnType<typeof routeStudioMediaAsset> {
    if (composer.mode === 'agent') {
      if (!mime.startsWith('image/')) return { notice: '只支持图片参考' } as const;
      if (!empty && composer.files.length >= 16) return { notice: '参考图已满' } as const;
      return { target: 'images' } as const;
    }
    const slots = referenceSlots.current;
    return routeStudioMediaAsset(mime, {
      kind, videoMode, model, videoCaps: kind === 'video' ? videoCaps : null,
      maxImageReferences: sizeContext(providers, providers.find(item => item.alias === providerAlias), model).caps.maxRefImages,
      counts: empty ? { images: 0, mj: 0, videos: 0, audios: 0 } : {
        images: slots.referenceImages.length, mj: slots.mjRefs.image.length,
        videos: slots.referenceVideos.length, audios: slots.referenceAudios.length,
      },
    });
  }

  function addReferenceFile(file: File, mime: string, title: string) {
    if (composer.mode === 'agent') {
      if (mime.startsWith('image/')) composer.setFiles(current => [...current, file].slice(0, 16));
      return;
    }
    const slots = referenceSlots.current;
    const target = mediaReferenceRoute(mime, true);
    if ('notice' in target) { setAssetNotice(target.notice); return; }
    const current = target.target === 'frame' ? [slots.videoFrames.first, slots.videoFrames.last]
      : target.target === 'mj' ? slots.mjRefs.image : target.target === 'videos' ? slots.referenceVideos
        : target.target === 'audios' ? slots.referenceAudios : slots.referenceImages;
    if (current.includes(file)) { setAssetNotice('已在参考图中'); return; }
    const route = mediaReferenceRoute(mime);
    if ('notice' in route) { setAssetNotice(route.notice); return; }
    if (route.target === 'frame') {
      const slot = !slots.videoFrames.first ? 'first' : !slots.videoFrames.last && (videoCaps?.maxFrames ?? 2) >= 2 ? 'last' : null;
      if (!slot) { setAssetNotice('参考图已满'); return; }
      slots.videoFrames = { ...slots.videoFrames, [slot]: file }; setVideoFrames(slots.videoFrames);
    } else if (route.target === 'mj') {
      slots.mjRefs = { ...slots.mjRefs, image: [...slots.mjRefs.image, file] }; setMjRefs(slots.mjRefs);
    } else if (route.target === 'videos') { slots.referenceVideos = [...slots.referenceVideos, file]; setReferenceVideos(slots.referenceVideos); }
    else if (route.target === 'audios') { slots.referenceAudios = [...slots.referenceAudios, file]; setReferenceAudios(slots.referenceAudios); }
    else { slots.referenceImages = [...slots.referenceImages, file]; setReferenceImages(slots.referenceImages); }
    sourceTitleFile.current = file; setPromptAssetSourceTitle(title); setClickPinned(true); setAssetNotice('已加入参考图');
  }

  async function addCreationAssetReference(asset: CreationAsset, content: CreationMediaAssetContent) {
    const route = mediaReferenceRoute(content.mime_type);
    if ('notice' in route) { setAssetNotice(route.notice); return; }
    try {
      const file = await readCreationMediaFile(asset.asset_id, content);
      addReferenceFile(file, content.mime_type, asset.title);
    } catch (error) { setAssetNotice(errorText(error)); }
  }

  async function deleteFailedRound(jobId: string) {
    const resp = await connectionFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    // 删不掉要说话：静默 return 的话画师点了删除、记录还在，只能当成界面卡了。
    if (!resp.ok) { notify.error(errorText(await apiError(resp, '删除这条失败记录'))); return; }
    setPersistedJobs((jobs) => jobs.filter((j) => j.job_id !== jobId));
    setRounds((items) => items.filter((item) => item.kind !== 'failed' || item.jobId !== jobId));
  }

  function dismissLocalRound(clientKey: string) {
    localSubmissionFiles.current.delete(clientKey);
    localRequestIds.current.delete(clientKey);
    setRounds(items => items.filter(item => item.clientKey !== clientKey));
  }

  async function cancelRound(jobId: string) {
    const resp = await connectionFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    if (!resp.ok) { notify.error(errorText(await apiError(resp, '停止生成'))); return; }
    // 后端只登记停止请求，status 仍是 pending；本地先把按钮翻成「正在停止」，终态由 SSE 带回。
    setPersistedJobs((jobs) => jobs.map((j) => (
      j.job_id === jobId && !j.cancel_requested_at ? { ...j, cancel_requested_at: new Date().toISOString() } : j
    )));
  }

  async function reEdit(config: RoundConfig, jobId?: string) {
    const requestSequence = ++reEditSequence.current;
    setClickPinned(true);
    try {
      const refs = await fetchRoundReferences(config, jobId);
      if (requestSequence !== reEditSequence.current) return;
      const before = snapshotIfFilled();
      applyRoundConfig(config, refs);
      flashInput('prompt');
      offerUndo(before);
    } catch (error) {
      if (requestSequence !== reEditSequence.current) return;
      setAssetNotice(errorText(error, '参考素材恢复失败'));
    }
  }

  // 「使用提示词」只填正文（与提示词资产一致），不换模型、参数和参考。
  function usePrompt(config: RoundConfig) {
    setClickPinned(true);
    if (composer.mode === 'agent') {
      const filled = composer.text.trim() || composer.files.length > 0;
      const before = filled ? editorRef.current : null;
      composer.setText(config.prompt);
      offerUndo(before);
      return;
    }
    const before = snapshotIfFilled();
    setPromptText(config.prompt);
    sourceTitleFile.current = null;
    setPromptAssetSourceTitle(config.sourceAssetTitle ?? null);
    flashInput('prompt');
    offerUndo(before);
  }

  // 素材全部取回后再一次性替换编辑器快照（重新编辑 / 复刻共用）；取回失败时调用方不会走到这里，
  // 用户当前编辑内容原样保留。全能参考按实际取回的素材判：复刻时 config 的路径字段是空的。
  function applyRoundConfig(config: RoundConfig, refs: RoundReferenceFiles) {
    const targetKind = config.kind ?? 'image';
    setVideoSeed(targetKind === 'video' ? config.videoSeed : undefined);
    const omni = isOmniVideoConfig(config.frameMode, {
      images: refs.images.length,
      videos: refs.videos.length,
      audios: refs.audios.length,
    });
    setRecipeNotice(null);
    setKind(targetKind);
    if (config.alias) setProviderAlias(config.alias);
    setModel(config.model);
    if (targetKind === 'video') {
      if (config.ratio) setVideoRatio(config.ratio);
      if (config.videoResolution) setVideoResolution(config.videoResolution);
      if (config.duration) setDuration(config.duration);
      if (config.videoQuality) setVideoQuality(config.videoQuality);
      if (config.n) setVideoCount(clampImageCount(config.n));
      setVideoMode(omni ? 'omni' : 'firstlast');
      setGenerateAudio(!!config.generateAudio);
    } else {
      setSizeParams({ workflow_inputs: config.workflowInputs, size_mode: config.sizeMode ?? 'ratio', size: config.size, ratio: config.ratio, resolution: config.resolution, ...(config.sizeMode === 'custom' ? { custom_size: config.size } : {}), complexity: config.complexity, output_format: config.output_format, frame_count: config.frame_count, frame_duration_ms: config.frame_duration_ms, background: config.background });
      if (config.n) setCount(clampImageCount(config.n));
      if (config.quality) setQuality(config.quality);
      if (config.mjParams) setMjParams(config.mjParams);
    }

    setReferenceImages([]);
    setReferenceVideos([]);
    setReferenceAudios([]);
    setVideoFrames({ first: null, last: null });
    setMjRefs(EMPTY_MJ_REFS);
    if (targetKind === 'video') {
      if (omni) {
        setReferenceImages(refs.images);
        setReferenceVideos(refs.videos);
        setReferenceAudios(refs.audios);
      } else if (config.frameMode === 'last') {
        setVideoFrames({ first: null, last: refs.images[0] ?? null });
      } else {
        setVideoFrames({ first: refs.images[0] ?? null, last: refs.images[1] ?? null });
      }
    } else {
      const routed = routeReusedImageFiles(config.model, config.model, {
        image: refs.images,
        sref: refs.sref,
        cref: refs.cref,
        oref: refs.oref,
      });
      setReferenceImages(routed.referenceImages);
      setMjRefs(routed.mjRefs);
      setReuseLimitNotice(routed.droppedCount > 0);
    }
    // 模式与素材已同步排入同一批状态更新，Prompt 里的 @图片N 会直接生成带缩略图的 chip。
    setPromptText(config.prompt);
    sourceTitleFile.current = null;
    setPromptAssetSourceTitle(config.sourceAssetTitle ?? null);
  }

  // 「再次生成」按旧配置直接提交，不改输入壳（D6）。本地失败卡带着当时的文件重新上传，旧卡换成新的一轮。
  // 受理未知的本地失败卡先按请求 ID 核对：查到就接上原任务，查不到才用同一请求 ID 重新提交，核对失败什么都不发。
  async function regenerate(config: RoundConfig, failedJobId?: string, clientKey?: string) {
    const requestId = clientKey ? localRequestIds.current.get(clientKey) : undefined;
    if (clientKey && requestId && await reconcileLocalSubmission(clientKey) !== false) return;
    const files = clientKey ? localSubmissionFiles.current.get(clientKey) : undefined;
    if (clientKey) dismissLocalRound(clientKey);
    await onSubmit(config.prompt, config, undefined, failedJobId, files, requestId);
  }

  function regenerateHint(config: RoundConfig): string {
    const name = config.provider === 'chatgpt' ? 'GPT Image' : modelDisplayName({ id: config.model, name: config.modelName });
    const channel = resolveChannel(keys, providers.find(item => item.alias === config.alias), config.model);
    const cost = channel.key && config.sizeMode !== 'auto'
      ? estimateGenerationCostForSubmission(channel.key, channel.modelId, config.kind === 'video' ? 'video' : 'image', configCostParams(config))
      : null;
    return cost != null ? `${name} · ${costLabel(cost)}` : name;
  }

  // 删除不确认：进回收站，右上角 8 秒撤销。多张的一轮里删一张只摘这一张。
  async function trashRound(jobId: string, path?: string) {
    const job = latestJobs.current.find(item => item.job_id === jobId);
    const single = Boolean(path && job && job.output_paths.length > 1);
    let trashId: string;
    try {
      trashId = await deleteStudioRound(jobId, single ? path : undefined);
    } catch (error) {
      notify.error(errorText(error));
      return;
    }
    setPersistedJobs(jobs => single
      ? jobs.map(item => item.job_id === jobId ? { ...item, output_paths: item.output_paths.filter(output => output !== path) } : item)
      : jobs.filter(item => item.job_id !== jobId));
    notify.undo(single ? (job?.kind === 'video' ? '已删除这条视频' : '已删除这张图') : '已删除这一轮', () => {
      void restoreTrash(trashId)
        .then(() => refreshPersistedJobs())
        .catch(error => notify.error(errorText(error)));
    });
  }

  function handleFailureAction(action: JobErrorAction, round: Extract<RoundState, { kind: 'failed' }>) {
    const { config } = round;
    if (action.kind === 'topup' && action.href) {
      window.open(action.href, '_blank', 'noopener,noreferrer');
    } else if (action.kind === 'topup' || action.kind === 'open_provider' || action.kind === 'edit_endpoint') {
      setLocation('/settings/providers');
    } else if (action.kind === 'reconnect') {
      window.location.reload();
    } else if (action.kind === 'requery') {
      if (round.jobId) void requeryRound(round.jobId);
      else if (round.clientKey) void recheckLocalSubmission(round.clientKey);
    } else if (action.kind === 'retry' && config) {
      void regenerate(config, round.jobId, round.jobId ? undefined : round.clientKey);
    } else if ((action.kind === 'change_model' || action.kind === 'edit_prompt') && config) {
      void reEdit(config, round.jobId);
    }
  }

  async function addResultToCanvas(jobId: string, index: number, projectId: string) {
    try {
      const target = sharedTargets.find(card => card.peer_key + '/' + card.project_id === projectId);
      if (target) {
        try {
          await shareStudioResult(jobId, index, target.peer_key, target.project_id);
        } catch (error) {
          if (!(error instanceof ApiError) || (error.status !== 401 && !(error.status === 403 &&
              (error.reason === '请先进入共享画布' || error.reason === '请重新输入访问口令')))) throw error;
          const profile = await fetchProfile();
          if (!profile.display_name || target.requires_passcode) {
            setSharedAuth({ target, needsName: !profile.display_name, jobId, index });
            return;
          }
          await authenticateCollab(target.peer_key, target.project_id);
          await shareStudioResult(jobId, index, target.peer_key, target.project_id);
        }
        setAssetNotice(`已加入画布「${clipName(target.name)}」`);
        return;
      }
      await addStudioResultToCanvas(jobId, index, projectId);
    } catch (error) {
      notify.error(errorText(error));
      return;
    }
    const name = canvasTargets.find(target => target.project_id === projectId)?.name;
    setAssetNotice(name ? `已加入画布「${clipName(name)}」` : '已加入画布');
  }

  // Agent 一轮出错或被停止：用同一条消息和附件重发一次。
  async function retryAgentTurn(turn: StudioAgentTurn, messages: StudioAgentSession['messages']) {
    const text = messages.find(message => message.role === 'user')?.text ?? '';
    const sessionId = session?.session_id;
    if (!sessionId) return;
    try {
      const files = await Promise.all(turn.attachment_ids.map(async (id, index) => {
        const response = await connectionFetch(`${agentSessionPath(null, sessionId)}/attachments/${encodeURIComponent(id)}`);
        if (!response.ok) throw await apiError(response, '取回附件');
        const blob = await response.blob();
        return new File([blob], `attachment-${index + 1}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: blob.type || 'image/png' });
      }));
      await composer.agent.sendStudio(text, files, turn.asset_ids, null, crypto.randomUUID());
    } catch (error) {
      notify.error(errorText(error));
    }
  }
}

// 服务器资产路径 → File。三类来源分流字节端点（与 RoundList 的 refImageSrc 同规则）：
// 历史 http(s) 参考直链不属于本机 API，必须 omit credentials，不能携带本机会话或 client ID。
// characters/studio 资产走 /api/gallery/image（/api/raw 不带 job_id
// 只放行 .runtime/uploads/，角色/出图产物会 403）；其余临时上传走 /api/raw。
async function fetchAssetAsFile(path: string, baseName: string, jobId?: string): Promise<File> {
  const url = path.startsWith('http')
    ? path
    : jobId
      ? `/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`
      : /^(characters|studio)\//.test(path) || /\/(characters|studio)\//.test(path)
        ? `/api/gallery/image?path=${encodeURIComponent(path)}`
        : `/api/raw?path=${encodeURIComponent(path)}`;
  const resp = await (url.startsWith('http') ? fetch(url, { credentials: 'omit' }) : connectionFetch(url));
  if (!resp.ok) throw await apiError(resp, '取回参考图');
  const blob = await resp.blob();
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([blob], `${baseName}.${ext}`, { type: blob.type || 'image/png' });
}

function galleryMediaUrl(path: string): string {
  return `/api/gallery/image?path=${encodeURIComponent(path)}`;
}

/** 生成资产冻结快照里的一份参考内容 → File（按快照登记的 mime 命名，不信任响应头）。 */
async function fetchRecipeInput(assetId: string, input: RecipeInput): Promise<File> {
  const response = await connectionFetch(creationAssetInputUrl(assetId, input.order));
  if (!response.ok) throw await apiError(response, '取回复刻参考素材');
  const blob = await response.blob();
  const ext = (input.mime_type.split('/')[1] ?? 'bin').split(/[+;]/)[0].replace('jpeg', 'jpg');
  return new File([blob], `ref-${input.order + 1}.${ext}`, { type: input.mime_type });
}

function withoutMissingModel(notice: RecipeNotice | null): RecipeNotice | null {
  if (!notice?.missingModel) return notice;
  return notice.warnings.length > 0 ? { missingModel: null, warnings: notice.warnings } : null;
}

async function fetchRoundReferences(config: RoundConfig, jobId?: string): Promise<RoundReferenceFiles> {
  const fetchGroup = (paths: string[], prefix: string) => Promise.all(
    paths.map((path, i) => fetchAssetAsFile(path, `${prefix}-${i + 1}`, jobId)),
  );
  const [images, videos, audios, sref, cref, oref] = await Promise.all([
    fetchGroup(config.referenceImages, 'ref'),
    fetchGroup(config.referenceVideos ?? [], 'video-ref'),
    fetchGroup(config.referenceAudios ?? [], 'audio-ref'),
    fetchGroup(config.mjRefPaths?.sref ?? [], 'style-ref'),
    fetchGroup(config.mjRefPaths?.cref ?? [], 'character-ref'),
    fetchGroup(config.mjRefPaths?.oref ?? [], 'omni-ref'),
  ]);
  return { images, videos, audios, sref, cref, oref };
}

type RoundHandoff = { clientKey: string; startedAt: number };

function withHandoff(round: RoundState, handoffs: ReadonlyMap<string, RoundHandoff>): RoundState {
  const handoff = round.jobId ? handoffs.get(round.jobId) : undefined;
  if (!handoff) return round;
  return round.kind === 'pending'
    ? { ...round, clientKey: handoff.clientKey, startedAt: handoff.startedAt }
    : { ...round, clientKey: handoff.clientKey };
}

function jobSessionId(job: Job) {
  return job.studio_agent_session_id ?? DEFAULT_STUDIO_SESSION_ID;
}

function studioJobsToRounds(jobs: Job[], keys: KeyView[] = [], order: 'desc' | 'asc' = 'desc'): RoundState[] {
  return jobs
    .filter((job) => job.status !== 'pending_confirm')
    .sort((a, b) => order === 'asc'
      ? Date.parse(a.submitted_at) - Date.parse(b.submitted_at)
      : Date.parse(b.submitted_at) - Date.parse(a.submitted_at))
    .flatMap((job): RoundState[] => {
      const mode = deriveGenMode(job);
      if (job.status === 'done' || job.status === 'partial') {
        if (job.output_paths.length === 0) return [];
        return [{
          kind: 'done' as const,
          mode,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          completedAt: job.completed_at,
          imagePaths: job.output_paths,
          // R6：只有 studio 自家出图能分享；归档来的角色 / UI 等记录不行。
          shareable: job.namespace === 'studio',
          generationCost: frozenGenerationCost(job),
          config: configForJob(job, keys),
        }];
      }
      if (job.status === 'failed' || job.status === 'canceled') {
        const canceled = job.status === 'canceled';
        return [{
          kind: 'failed' as const,
          mode,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          reason: job.error ?? (canceled ? '已停止' : '生成失败'),
          canceled,
          config: configForJob(job, keys),
          ...(canceled ? {} : { failure: jobFailure(job, keys) }),
        }];
      }
      return [{
        kind: 'pending' as const,
        mode,
        jobId: job.job_id,
        startedAt: Date.parse(job.submitted_at) || Date.now(),
        progressPhase: job.progress_phase ?? null,
        cancelRequested: job.cancel_requested_at != null,
        config: configForJob(job, keys),
      }];
    });
}

/** 失败任务 → 一句原因 + 修复动作。上游有任务号（或网关幂等键）可以续查的，结局不明时给「重新查询」，
 *  不给「再次生成」；没法续查的只给原因（原文在技术详情里）。 */
function jobFailure(job: Job, keys: KeyView[]): RoundFailure {
  const presentation = presentJobError(job, keys.find(key => key.alias === job.alias));
  if (canRequeryStudioJob(job) && REQUERY_CODES.has(job.error_code ?? 'unknown')) {
    return { message: presentation.message, action: { label: '重新查询', kind: 'requery' } };
  }
  return presentation.action?.kind === 'requery' ? { message: presentation.message } : presentation;
}

const REQUERY_CODES = new Set<JobErrorCode>(['timeout', 'submission_unconfirmed', 'network', 'unknown']);
const REQUERY_PROTOCOLS = new Set(['tuzi_images', 'atelier_gateway', 'declarative', 'evolink']);

/** 与服务端 `jobs.is_resumable_studio_job` 同一判据的前端近似；放不放行以服务端为准（不行返回 409）。 */
function canRequeryStudioJob(job: Job): boolean {
  const params = job.params;
  if ((params.provider_task_ids ?? []).some(Boolean)
    && (REQUERY_PROTOCOLS.has(params.provider_task_protocol ?? '') || job.provider === 'comfyui')) {
    return true;
  }
  return job.provider === 'atelier' && Boolean(params.gateway_unconfirmed && params.gateway_idempotency_key);
}

function hasFiles(files: SubmissionFiles): boolean {
  return [files.images, files.frames ?? [], files.videos, files.audios, ...Object.values(files.mjRefs)]
    .some(list => list.length > 0);
}

function frozenGenerationCost(job: Job): number | undefined {
  const actual = job.params?.actual_cost_cny;
  const amount = typeof actual === 'number' && Number.isFinite(actual) && actual >= 0
    ? actual
    : job.params?.estimated_cost_cny;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
    ? amount
    : undefined;
}

function upsertJob(items: Job[], next: Job): Job[] {
  const without = items.filter((item) => item.job_id !== next.job_id);
  return [next, ...without];
}
