import { connectionFetch } from '@/api/connection';
import { mediaUrl } from '@/api/connection';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ChevronsDown, Library } from 'lucide-react';

import { createStudioJob, getStudioJob, listStudioJobs, resolveImageReferencePaths, uploadReferenceImage } from '@/api/studio';
import { apiError } from '@/api/http';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { useSSE, type JobChangedPayload } from '@/hooks/useSSE';
import { PromptInput } from '@/components/studio/PromptInput';
import {
  CreationAssetPanel,
  type CreationAssetPanelHandle,
  type CreationAssetPanelMode,
  type CreationAssetSaveRequest,
} from '@/components/assets/CreationAssetPanel';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import { EMPTY_MJ_REFS, routeReusedImageFiles, type MjRefSlots } from '@/components/studio/MjReferenceSlots';
import { RoundList, type RoundConfig, type RoundState, type SaveResultAssetRequest } from '@/components/studio/RoundList';
import { StudioQueryBar } from '@/components/studio/StudioQueryBar';
import { StudioArchiveDialog, type StudioArchiveRequest } from '@/components/studio/StudioArchiveDialog';
import { TeamShareDialog, type TeamShareDialogRequest } from '@/components/studio/TeamShareDialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { imageSizeMode, normalizeImageSizeParams, prepareImageSizeSubmission } from '@/lib/imageSizeMode';
import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import { imageFamily } from '@/lib/modelFamily';
import { promptToAssetSegments } from '@/lib/promptVariables';
import { hasSrefCode, MJ_DEFAULTS, mjParamsToJob, type MjParams } from '@/lib/mjParams';
import { videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import { deriveGenMode, filterRounds, DEFAULT_HISTORY_FILTERS, type HistoryFilters } from '@/lib/historyFilters';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { useGalleryHidden } from '@/hooks/useGalleryHidden';
import { StudioCompact } from './StudioCompact';
import { convergeModelSelection, modelsForKind } from './studioModelSelection';
import type { Job, JobKind, JobParams } from '@/schema/jobs';
import { readStudioDraft, writeStudioDraft } from './studioDraft';
import { clampImageCount, configForJob, isOmniVideoConfig, referencePathCounts } from './studioJobConfig';
import { routeStudioMediaAsset } from './studioAssetRouting';
import { recipeToDraft } from './studioRecipe';
import { creationAssetInputUrl, creationAssetMediaUrl, markCreationAssetUsed } from '@/api/creationAssets';
import { listCanvasProjects } from '@/api/canvas';
import { adoptTeamAsset, listTeamLibraries } from '@/api/teamLibraries';
import { TEAM_ASSET_ACTION_EVENT, teamAssetActionFromSearch, type TeamAssetAction } from '@/lib/teamAssetActions';
import type { CreationAsset, CreationMediaAssetContent, RecipeInput } from '@/schema/creationAssets';
import type { CanvasProject } from '@/schema/canvas';

const SELECTION_STORAGE_KEY = 'studio:selection';
const ASSET_TITLE_LENGTH = 24;

interface RoundReferenceFiles {
  images: File[];
  videos: File[];
  audios: File[];
  sref: File[];
  cref: File[];
  oref: File[];
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
  const [saved] = useState(loadSelection);
  const [draft] = useState(readStudioDraft);
  const [rounds, setRounds] = useState<RoundState[]>([]);
  // 查询面板筛选 + 收藏/隐藏集（渲染端筛选用，state 仍保留全量轮）。setHistoryFilters 喂 StudioQueryBar，
  // toggleFavorite 透传到结果卡 ★ 收藏按钮。
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const { favorites, toggleFavorite } = useGalleryFavorites();
  const { hiddenPaths, toggleHidden } = useGalleryHidden();
  const [persistedJobs, setPersistedJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState(false);
  const [keys, setKeys] = useState<KeyView[]>([]);
  // listKeys 返回（成功或失败）后才为 true：区分「还在加载」与「加载完了但一个 key 都没有」。
  const [keysLoaded, setKeysLoaded] = useState(false);
  // 滚动联动收放：历史区 col-reverse（|scrollTop| 即距底距离），>160 收 / <80 展（滞回防抖）。
  // shellFocused / clickPinned 是两个展开覆盖：输入焦点期间恒展开；点击收缩壳展开但不回滚，
  // 再次滚动（dist>160 的 scroll 事件）即取消点击钉住。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [shellFocused, setShellFocused] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
  const [reuseLimitNotice, setReuseLimitNotice] = useState(false);
  const [assetNotice, setAssetNotice] = useState<string | null>(null);
  const [location, setLocation] = useLocation();
  const [archiveRequest, setArchiveRequest] = useState<StudioArchiveRequest | null>(null);
  const [shareRequest, setShareRequest] = useState<TeamShareDialogRequest | null>(null);
  const [reproduceConfirm, setReproduceConfirm] = useState<CreationAsset | null>(null);
  const [recipeNotice, setRecipeNotice] = useState<RecipeNotice | null>(null);
  const dockCollapsed = scrolledUp && !shellFocused && !clickPinned;

  // 不走 rAF 节流：后台标签页 rAF 会挂起导致联动滞后；setState 同值自动 bail-out，开销可忽略。
  const handleHistoryScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = Math.abs(el.scrollTop);
    setScrolledUp((prev) => (prev ? dist > 80 : dist > 160));
    if (dist > 160 || dist <= 80) setClickPinned(false);
  };

  // 瞬时跳转（飙哥指定）：回到底部不要从上往下滚的过程。
  const scrollToBottom = () => scrollRef.current?.scrollTo?.({ top: 0, behavior: 'auto' });

  // state 仍 newest-first（提交逻辑零改动）；先按查询面板筛选，再反转使最新一轮落底。
  const reversedRounds = useMemo(
    () => [...filterRounds(rounds, historyFilters, favorites, hiddenPaths)].reverse(),
    [rounds, historyFilters, favorites, hiddenPaths],
  );
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  // 尺寸模式和自定义草稿一起恢复；质量与数量仍在刷新时回默认。
  const [sizeParams, setSizeParams] = useState<JobParams>(draft?.sizeParams ?? saved.sizeParams ?? {});
  const [count, setCount] = useState(draft?.count ?? 1);
  const [quality, setQuality] = useState<Quality>(draft?.quality ?? 'low');
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
  const [promptAssetSourceTitle, setPromptAssetSourceTitle] = useState<string | null>(draft?.promptAssetSourceTitle ?? null);
  const [referenceImages, setReferenceImages] = useState<File[]>(draft?.referenceImages ?? []);
  const [kind, setKind] = useState<JobKind>(draft?.kind ?? saved.kind ?? 'image');
  // 旧版本 videoMode 存过 t2v/i2v/ref/v2v —— 仅 'omni' 原样保留，其余一律回落首尾帧。
  const [videoMode, setVideoMode] = useState<VideoMode>(draft?.videoMode ?? (saved.videoMode === 'omni' ? 'omni' : 'firstlast'));
  const [duration, setDuration] = useState<number>(draft?.duration ?? saved.duration ?? 5);
  const [videoResolution, setVideoResolution] = useState<string>(draft?.videoResolution ?? saved.videoResolution ?? '720p');
  const [videoRatio, setVideoRatio] = useState<string>(draft?.videoRatio ?? saved.videoRatio ?? '16:9');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(draft?.videoQuality ?? (saved.videoQuality === 'pro' ? 'pro' : 'std'));
  const [videoCount, setVideoCount] = useState<number>(draft?.videoCount ?? clampImageCount(saved.videoCount ?? 1));
  const [generateAudio, setGenerateAudio] = useState<boolean>(draft?.generateAudio ?? saved.generateAudio ?? false);
  const [referenceVideos, setReferenceVideos] = useState<File[]>(draft?.referenceVideos ?? []);
  const [referenceAudios, setReferenceAudios] = useState<File[]>(draft?.referenceAudios ?? []);
  // 首尾帧模式的双槽（与 referenceImages 分离：两个槽各自独立可空，仅尾帧也合法）。
  const [videoFrames, setVideoFrames] = useState<FrameSlots>(draft?.videoFrames ?? { first: null, last: null });

  // 每次改动都把未提交的输入写进内存草稿；切页卸载后回来按它恢复，刷新即清空。
  useEffect(() => {
    writeStudioDraft({
      providerAlias, model, kind, promptText, promptAssetSourceTitle,
      referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs, mjParams,
      sizeParams, count, quality,
      videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, kind, promptText, promptAssetSourceTitle,
    referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs, mjParams,
    sizeParams, count, quality,
    videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);

  useEffect(() => {
    if (!assetPanelOpen) return;
    let cancelled = false;
    void listCanvasProjects(true)
      .then(projects => { if (!cancelled) setCanvasTargets(projects); })
      .catch(() => { if (!cancelled) setCanvasTargets([]); });
    return () => { cancelled = true; };
  }, [assetPanelOpen]);
  // 重新编辑会异步拉取历史参考素材；只允许最后一次点击的结果回填，避免慢请求覆盖新选择。
  const reEditSequence = useRef(0);
  const selectedModelObj = keys.find((k) => k.alias === providerAlias)?.models.find((m) => m.id === model);
  const videoCaps = videoControlCaps(model, selectedModelObj?.protocol);
  // 切换生成类型 / keys 加载时把 alias、model 收敛到本类模型（规则见 convergeModelSelection）：
  // 界面显示的模型就是提交的模型；复刻缺模型（model 为空）时只换 key，模型位留空。
  useEffect(() => {
    const next = convergeModelSelection(keys, kind, providerAlias, model);
    if (!next) return;
    setProviderAlias(next.alias);
    setModel(next.model);
    // 仅在切换类型 / keys 加载时触发；alias / model 不入依赖，避免用户改选时被反复抢回成死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, keys]);
  // 切换视频模型族时把超出 caps 的选择拉回合法值（如 seedance 21:9 → kling 没有；kling 档位 ↔ seedance 无档位）。
  useEffect(() => {
    // 模型未定（复刻缺模型）时不按兜底 caps 钳制：配方的时长 / 分辨率 / 比例留到用户选了模型再按它收。
    if (kind !== 'video' || !model) return;
    const selModel = keys.find((k) => k.alias === providerAlias)?.models.find((m) => m.id === model);
    const caps = videoControlCaps(model, selModel?.protocol);
    if (!caps.modes.includes(videoMode)) setVideoMode(caps.modes[0]);
    if (caps.ratios.length > 0 && !caps.ratios.includes(videoRatio)) setVideoRatio(caps.ratios[0]);
    if (caps.durations.length > 0 && !caps.durations.includes(duration)) setDuration(caps.durations[0]);
    if (caps.resolutions.length > 0 && !caps.resolutions.includes(videoResolution)) {
      setVideoResolution(caps.resolutions[0]);
    }
    if (caps.qualities && !caps.qualities.includes(videoQuality)) setVideoQuality(caps.qualities[0]);
  }, [kind, keys, providerAlias, model, videoMode, videoRatio, duration, videoResolution, videoQuality]);
  const handleSizeParamsChange = useCallback((patch: JobParams) => {
    setSizeParams(previous => {
      const selected = keys.find(key => key.alias === providerAlias);
      return normalizeImageSizeParams(model, selected?.provider, selected?.base_url, { ...previous, ...patch });
    });
  }, [keys, providerAlias, model]);

  // 点击历史记录里的参考图 → 把这批参考图（服务器路径）拉回成 File[]，整组塞进输入框复用出图。
  const handleReuseReferences = useCallback(async (config: RoundConfig, jobId?: string) => {
    const { images, videos, audios, sref, cref, oref } = await fetchRoundReferences(config, jobId);
    const routed = routeReusedImageFiles(model, config.model, { image: images, sref, cref, oref });
    setReferenceImages(routed.referenceImages);
    setReferenceVideos(videos);
    setReferenceAudios(audios);
    setMjRefs(routed.mjRefs);
    setReuseLimitNotice(routed.droppedCount > 0);
  }, [model]);

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
  const handleEditAsReference = useCallback(async (path: string) => {
    const target: 'stack' | 'frame' | 'mj' = kind === 'video'
      ? (videoMode === 'omni' ? 'stack' : 'frame')
      : imageFamily(model) === 'midjourney' ? 'mj' : 'stack';
    setClickPinned(true);
    // 纯文生视频（maxFrames=0）没有首帧槽，导进去提交时也读不到 —— 不做无效写入。
    if (target === 'frame' && (videoCaps?.maxFrames ?? 2) < 1) return;
    const sourceOf = (f: File | null) => (f ? editRefSource.current.get(f) : undefined);
    const already = target === 'stack'
      ? referenceImages.some((f) => sourceOf(f) === path)
      : target === 'frame'
        ? sourceOf(videoFrames.first) === path
        : mjRefs.image.some((f) => sourceOf(f) === path);
    // 已经导过同一张：不叠第二份。
    if (already) return;
    try {
      const file = await fetchAssetAsFile(path, path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'edit-ref');
      editRefSource.current.set(file, path);
      if (target === 'frame') {
        setVideoFrames((prev) => ({ ...prev, first: file }));
      } else if (target === 'mj') {
        setMjRefs((prev) => ({ ...prev, image: [...prev.image, file] }));
      } else {
        setReferenceImages((prev) => [...prev, file]);
      }
    } catch (e) {
      console.warn('[studio] 参考图导入失败（源文件取不到）', path, e);
    }
  }, [kind, videoMode, model, videoCaps?.maxFrames, videoFrames.first, mjRefs.image, referenceImages]);

  // 首页作品深链（/studio?job=<id>）：目标轮出现在历史里后滚动定位（居中），一次性消费。
  const search = useSearch();
  const targetJobId = useMemo(() => new URLSearchParams(search).get('job'), [search]);
  const focusConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetJobId || focusConsumedRef.current === targetJobId) return;
    const found = rounds.some((r) => r.jobId === targetJobId);
    if (!found) return;
    focusConsumedRef.current = targetJobId;
    const scrollToRound = () => {
      document
        .querySelector(`[data-round-job="${CSS.escape(targetJobId)}"]`)
        ?.scrollIntoView({ block: 'center' });
    };
    // 图片异步加载会把布局往下推，定位后再补两次纠偏。
    // 不返回 cleanup：deps 里的 rounds 随 SSE/轮询频繁变化，effect 重跑会把上一轮的
    // 一次性定时器掐掉。定时器是幂等一次性动作，放着跑完即可。
    scrollToRound();
    setTimeout(scrollToRound, 600);
    setTimeout(scrollToRound, 1600);
  }, [rounds, targetJobId]);

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

  const refreshPersistedJobs = useCallback(async () => {
    const jobs = await listStudioJobs();
    setPersistedJobs(jobs);
    return jobs;
  }, []);

  // SSE 定向更新：watcher 广播的 {job_id, status} 直接按 job_id 拉单条，
  // 替代旧的「有活跃 job 时每 2s 全量 refetch + 每次提交各自轮询」三路放大。
  const handleJobChanged = useCallback((data: JobChangedPayload) => {
    if (!data.job_id) return;
    void getStudioJob(data.job_id).then((job) => {
      // 非 studio job（角色出图）返回 null，忽略。
      if (job) setPersistedJobs((items) => upsertJob(items, job));
    });
  }, []);

  // onConnect 全量刷新兜底：断连期间 / SSE 队列满丢掉的事件靠重连补齐。
  useSSE({
    onJobChanged: handleJobChanged,
    onConnect: () => { void refreshPersistedJobs().catch(() => {}); },
  });

  // SSE 兜底轮询：系统代理（Clash/V2Ray 的 TUN/全局模式）会把 127.0.0.1 的流式响应整条缓冲，
  // 心跳字节也被憋住，浏览器连接看着"正常开着"、永不 onerror、永不重连 —— 出图完成后前端卡
  // "生成中"直到手刷（普通 GET 不走流式缓冲，所以手刷能出）。#18 砍掉常驻 2s 轮询让 SSE 成
  // 唯一命脉，放大了这个脆弱点。这里只要还有 pending 轮次就每 4s 全量拉一次（= 自动帮用户手刷），
  // 出完自动翻面；无 pending 不轮询，保留 #18 的初衷。
  const hasPendingRound = rounds.some((r) => r.kind === 'pending');
  useEffect(() => {
    if (!hasPendingRound) return;
    const timer = setInterval(() => { void refreshPersistedJobs().catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [hasPendingRound, refreshPersistedJobs]);

  useEffect(() => {
    let cancelled = false;
    listStudioJobs()
      .then((jobs: Job[]) => {
        if (cancelled) return;
        setPersistedJobs(jobs);
      })
      .catch(() => {
        if (!cancelled) {
          setPersistedJobs([]);
        }
      });
    listKeys()
      .then((resp) => {
        if (cancelled) return;
        const usable = resp.keys.filter((key) => key.models.length > 0);
        setKeys(usable);
        // 优先恢复上次保存的供应商/模型（校验仍存在），否则回落到第一个可用 key。
        const wantedAlias = draft?.providerAlias || saved.providerAlias;
        const wantedModel = draft?.model || saved.model;
        const savedKey = wantedAlias
          ? usable.find((key) => key.alias === wantedAlias)
          : undefined;
        const selected = savedKey ?? usable[0];
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

  useEffect(() => {
    setRounds((items) =>
      mergePersistedRounds(
        items.map((item) => hydrateRoundModelName(item, keys)),
        studioJobsToRounds(persistedJobs, keys),
      ),
    );
  }, [keys, persistedJobs]);

  const onSubmit = async (prompt: string, overrideConfig?: RoundConfig, promptTemplate?: string) => {
    const wantVideo = overrideConfig ? overrideConfig.kind === 'video' : kind === 'video';
    if (wantVideo) {
      await onSubmitVideo(prompt, overrideConfig, promptTemplate);
      return;
    }
    const effectiveAlias = overrideConfig?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? model;
    const selectedKey = keys.find((item) => item.alias === effectiveAlias);
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    // 能力按模型族判；provider 只在 openrouter 上改 size 语义（比例串而非像素）。
    const caps = imageControlCaps(
      effectiveModel,
      effectiveProvider,
      selectedKey?.base_url,
    );
    // MJ 一次 imagine 固定回 4 张方案，张数不由画师定（见 MJ_IMAGES_PER_TASK）。
    const effectiveCount = caps.family === 'midjourney'
      ? MJ_IMAGES_PER_TASK
      : clampImageCount(overrideConfig?.n ?? count);
    const rawSizeParams: JobParams = overrideConfig
      ? { size_mode: overrideConfig.sizeMode ?? 'ratio', size: overrideConfig.size, ratio: overrideConfig.ratio, resolution: overrideConfig.resolution }
      : sizeParams;
    const preparedSize = prepareImageSizeSubmission(effectiveModel, effectiveProvider, selectedKey?.base_url, rawSizeParams);
    if (preparedSize.error) {
      alert(preparedSize.error);
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
    const effectiveMjParams = overrideConfig?.mjParams ?? mjParams;
    const effectiveSourceAssetTitle = overrideConfig
      ? overrideConfig.sourceAssetTitle
      : promptAssetSourceTitle ?? undefined;

    setPending(true);
    // 提交前把参考图 File[] 上传到 .runtime/uploads/，拿到服务器路径写进 params.reference_images。
    // 再次生成（overrideConfig）携带的已是服务器路径，直接复用。
    let refPaths: string[];
    let mjRefPaths: { sref?: string[]; cref?: string[]; oref?: string[] } = {};
    try {
      ({ referenceImages: refPaths, mjRefPaths } = await resolveImageReferencePaths({
        midjourney: caps.family === 'midjourney', referenceImages, mjRefs,
        overrideReferenceImages: overrideConfig?.referenceImages,
        overrideMjRefPaths: overrideConfig?.mjRefPaths,
        srefCodeActive: hasSrefCode(effectiveMjParams),
      }));
    } catch (e: any) {
      setPending(false);
      setRounds((rs) => [
        { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message },
        ...rs,
      ]);
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
      referenceImages: refPaths,
      ...(effectiveSourceAssetTitle ? { sourceAssetTitle: effectiveSourceAssetTitle } : {}),
      ...(caps.family === 'midjourney'
        ? { mjParams: effectiveMjParams, mjRefPaths }
        : {}),
    };
    // 控件隐藏的参数一律不写进 params（与视频侧同写法）：后端 openrouter_image 会把
    // params.resolution 原样当 API 参数发出去，在别的 key 上选过 4K 就会被带过来按 4K 计费。
    const jobParams: JobParams = {
      size_mode: effectiveMode,
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(effectiveRatio ? { ratio: effectiveRatio } : {}),
      ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { quality: effectiveQuality } : {}),
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
      selectedKey,
      effectiveModel,
      'image',
      jobParams,
    );
    if (estimatedCost != null && effectiveMode !== 'auto') jobParams.estimated_cost_cny = estimatedCost;

    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, config };
    setRounds((rs) => [myRound, ...rs]);
    // 新一轮提交后跳回底部（col-reverse 的底即 0），让用户看到 pending 卡片。
    scrollToBottom();

    let job: Job;
    try {
      job = await createStudioJob({
        prompt,
        ...(promptTemplate ? { prompt_template: promptTemplate } : {}),
        alias: effectiveAlias ?? undefined,
        model: effectiveModel,
        params: jobParams,
      });
    } catch (e: any) {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message, config } : r,
        ),
      );
      setPending(false);
      return;
    }
    setPending(false);
    // 提交真正发出去了，复刻时的提示才算用完。
    setRecipeNotice(null);

    setPersistedJobs((items) => upsertJob(items, job));
    // 终态翻面交给 SSE 定向更新（handleJobChanged → persistedJobs → mergePersistedRounds），
    // 不再每个提交各起一条 2s/5s 轮询。
    setRounds((rs) =>
      rs.map((r) =>
        r === myRound
          ? { ...myRound, jobId: job.job_id, startedAt: Date.parse(job.submitted_at) || startedAt }
          : r,
      ),
    );
  };

  const onSubmitVideo = async (prompt: string, overrideConfig?: RoundConfig, promptTemplate?: string) => {
    // 切到视频后 PromptInput 只是按模型分类过滤显示，父级 providerAlias/model 不一定已是视频 key——这里收敛。
    const videoModelsOf = (k: KeyView) => (k.models ?? []).filter((m) => modelModality(m, k) === 'video');
    const videoKeys = keys.filter((item) => videoModelsOf(item).length > 0);
    const selectedKey =
      (overrideConfig?.alias ? keys.find((item) => item.alias === overrideConfig.alias) : undefined)
      ?? videoKeys.find((item) => item.alias === providerAlias)
      ?? videoKeys[0];
    const selectedVideoModels = selectedKey ? videoModelsOf(selectedKey) : [];
    const effectiveAlias = overrideConfig?.alias ?? selectedKey?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model
      ?? (selectedVideoModels.some((m) => m.id === model) ? model : selectedVideoModels[0]?.id)
      ?? model;
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);
    // 协议由后端按模型 id/供应商自动判定（read_keys_db 回填）；前端只在已知时用它精化 caps。
    const effectiveCaps = videoControlCaps(effectiveModel, selectedModel?.protocol);

    setPending(true);
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
    try {
      imgPaths = overrideConfig?.referenceImages
        ?? (frameFiles
          ? await Promise.all(frameFiles.map(uploadReferenceImage))
          : referenceImages.length > 0 ? await Promise.all(referenceImages.map(uploadReferenceImage)) : []);
      vidPaths = overrideConfig?.referenceVideos
        ?? (referenceVideos.length > 0 ? await Promise.all(referenceVideos.map(uploadReferenceImage)) : []);
      audPaths = overrideConfig?.referenceAudios
        ?? (referenceAudios.length > 0 ? await Promise.all(referenceAudios.map(uploadReferenceImage)) : []);
    } catch (e: any) {
      setPending(false);
      setRounds((rs) => [
        { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message },
        ...rs,
      ]);
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
      selectedKey,
      effectiveModel,
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
      referenceImages: imgPaths,
      referenceVideos: vidPaths,
      referenceAudios: audPaths,
      ...(effectiveSourceAssetTitle ? { sourceAssetTitle: effectiveSourceAssetTitle } : {}),
    };

    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, config };
    setRounds((rs) => [myRound, ...rs]);
    // 新一轮提交后跳回底部（col-reverse 的底即 0），让用户看到 pending 卡片。
    scrollToBottom();

    let job: Job;
    try {
      job = await createStudioJob({
        prompt,
        ...(promptTemplate ? { prompt_template: promptTemplate } : {}),
        alias: effectiveAlias ?? undefined,
        model: effectiveModel,
        params: videoParams,
        kind: 'video',
      });
    } catch (e: any) {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message, config } : r,
        ),
      );
      setPending(false);
      return;
    }
    setPending(false);
    setRecipeNotice(null);

    setPersistedJobs((items) => upsertJob(items, job));
    // 同 onSubmit：终态翻面走 SSE 定向更新，无 per-job 轮询（视频分钟级，轮询放大更明显）。
    setRounds((rs) =>
      rs.map((r) =>
        r === myRound
          ? { ...myRound, jobId: job.job_id, startedAt: Date.parse(job.submitted_at) || startedAt }
          : r,
      ),
    );
  };

  return (
    <div
      className="relative h-[calc(100vh-56px)] md:h-[calc(100vh-80px)] overflow-hidden px-3 sm:px-6"
      aria-label="生图沙箱"
    >
      {/* 查询条：固定顶部覆盖层，不随历史滚动。wrapper 不收事件，条本体 pointer-events-auto。 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-end px-3 pt-4 sm:px-6">
        <StudioQueryBar filters={historyFilters} onChange={setHistoryFilters} />
      </div>
      {/* col-reverse：浏览器原生钉底，scrollTop 0 即底部；rounds 反转后最新一轮落在视觉底部。
          pt 让出查询条空间，pb 预留输入壳展开高度，最后一轮不被浮层压住。 */}
      <div
        ref={scrollRef}
        onScroll={handleHistoryScroll}
        data-studio-history-scroll
        data-testid="studio-history-scroll"
        className="flex h-full flex-col-reverse overflow-y-auto pt-20 pb-[210px]"
      >
        <RoundList
          rounds={reversedRounds}
          focusJobId={targetJobId ?? undefined}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          hiddenPaths={hiddenPaths}
          onToggleHidden={toggleHidden}
          onDeleteFailed={deleteFailedRound}
          onCancel={cancelRound}
          onReEdit={reEdit}
          onRegenerate={regenerate}
          onDeleteBatch={deleteDoneBatch}
          onReuseReferences={handleReuseReferences}
          onEditAsReference={handleEditAsReference}
          onArchive={(jobId, path, mediaKind) => setArchiveRequest({ jobId, path, mediaKind })}
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
      </div>
      {/* 浮层输入：wrapper 不收事件，两侧视觉与交互都穿透到历史区；壳本体在 PromptInput 内
          pointer-events-auto。 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 px-3 sm:px-6">
        <div className="relative mx-auto flex max-w-[844px] items-end gap-3">
          <div className="relative min-w-0 flex-1">
          {/* 回到底部：常驻挂载才有进出动画。锚定 bottom-full 让它跟着壳顶升降——
              壳展开时被顶着上移、同时向右上平移渐隐；收起时反向浮现。 */}
          <button
            type="button"
            onClick={scrollToBottom}
            tabIndex={dockCollapsed ? 0 : -1}
            aria-hidden={!dockCollapsed}
            className={`absolute bottom-full right-0 mb-3 inline-flex h-8 items-center gap-1 rounded-full border border-border bg-glass backdrop-blur-glass px-3 text-xs text-foreground transition-all duration-300 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              dockCollapsed
                ? 'pointer-events-auto opacity-100 translate-x-0 translate-y-0'
                : 'pointer-events-none opacity-0 translate-x-3 -translate-y-2'
            }`}
          >
            <ChevronsDown size={13} aria-hidden />
            回到底部
          </button>
        <div className="absolute bottom-full left-0 mb-2 flex flex-col items-start gap-1">
          {recipeNotice && (
            <div
              role="status"
              data-testid="studio-recipe-notice"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              {recipeNotice.missingModel && <p>本机没有 {recipeNotice.missingModel}</p>}
              {recipeNotice.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}
          {assetNotice && (
            <span
              role="status"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              {assetNotice}
            </span>
          )}
          {reuseLimitNotice && (
            <span
              role="status"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              历史参考图超过 MJ 每槽 4 张，已保留前 4 张
            </span>
          )}
        </div>
        <PromptInput
          collapsed={dockCollapsed}
          onExpandRequest={() => setClickPinned(true)}
          onShellFocusChange={setShellFocused}
          onSubmit={(prompt, template) => onSubmit(prompt, undefined, template)}
          disabled={pending}
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
          onSaveReferenceImage={(file) => {
            setAssetPanelKind('media');
            setAssetPanelOpen(true);
            setAssetSaveRequest({ requestId: crypto.randomUUID(), kind: 'media', file });
          }}
          providers={keys}
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
          kind={kind}
          onKindChange={setKind}
          videoMode={videoMode}
          videoCaps={videoCaps}
          duration={duration}
          videoResolution={videoResolution}
          videoRatio={videoRatio}
          videoQuality={videoQuality}
          videoCount={videoCount}
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
          <button
            type="button"
            aria-label="打开创作资产"
            aria-expanded={assetPanelOpen}
            onClick={() => {
              if (assetPanelOpen) assetPanelRef.current?.requestClose();
              else setAssetPanelOpen(true);
            }}
            className={`pointer-events-auto grid shrink-0 place-items-center rounded-full border border-input bg-glass text-muted-foreground backdrop-blur-glass transition-all duration-300 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              dockCollapsed ? 'mb-[22px] size-8' : 'mb-4 size-10'
            }`}
          >
            <Library
              size={18}
              aria-hidden
              className={`transition-transform duration-300 ${dockCollapsed ? 'scale-90' : ''}`}
            />
          </button>
        </div>
      </div>
      {assetPanelOpen && (
        <CreationAssetPanel
          key={assetPanelMount}
          ref={assetPanelRef}
          initialKind={assetPanelKind}
          initialTeamProjectId={teamPanelTarget?.projectId}
          initialTeamLibraryId={teamPanelTarget?.libraryId}
          canvasTargets={canvasTargets.map(target => ({
            projectId: target.project_id,
            name: target.name,
          }))}
          saveRequest={assetSaveRequest}
          onSaveRequestHandled={(requestId) => {
            setAssetSaveRequest(current => current?.requestId === requestId ? null : current);
          }}
          onClose={() => {
            setAssetPanelOpen(false);
            setTeamPanelTarget(null);
          }}
          onUsePrompt={(asset, renderedPrompt) => {
            setPromptText(renderedPrompt);
            setPromptAssetSourceTitle(asset.title);
            setClickPinned(true);
          }}
          onUseMedia={(asset, content) => { void addCreationAssetReference(asset, content); }}
          onReproduce={requestReproduce}
          onOpenSettings={canvasId => setLocation(`/settings?canvas=${encodeURIComponent(canvasId)}`)}
          onTeamAssetAdopted={result => setAssetNotice(result.created ? '已加入资产库' : '已在你的资产库')}
        />
      )}
      <StudioArchiveDialog request={archiveRequest} onClose={() => setArchiveRequest(null)} />
      <TeamShareDialog
        request={shareRequest}
        onClose={() => setShareRequest(null)}
        onShared={(_entry, libraryName) => setAssetNotice(`已分享到 ${libraryName}`)}
        onOpenSettings={() => {
          setShareRequest(null);
          setLocation('/settings');
        }}
      />
      <ConfirmDialog
        open={reproduceConfirm !== null}
        title="覆盖当前输入？"
        message=""
        confirmText="覆盖"
        onConfirm={() => {
          const asset = reproduceConfirm;
          setReproduceConfirm(null);
          if (asset) void reproduce(asset);
        }}
        onCancel={() => setReproduceConfirm(null)}
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
      setAssetNotice(error instanceof Error ? error.message : '复刻失败');
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
      setAssetNotice(error instanceof Error ? error.message : '读取团队库失败');
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

  // 复刻 = 把生成资产的配方填进当前输入框（同「重新编辑」），不自动提交；已有输入先确认覆盖。
  function requestReproduce(asset: CreationAsset) {
    // keys 未加载时判不出本机有没有配方模型，不能当成缺模型去填：先记下，加载完补做（为空则照常按缺模型填）。
    if (!keysLoaded) {
      pendingReproduceRef.current = asset;
      return;
    }
    if (hasEditorInput()) {
      setReproduceConfirm(asset);
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
      applyRoundConfig(
        { ...recipeDraft.config, sourceAssetTitle: asset.title },
        { images, videos, audios, sref, cref, oref },
      );
      // 缺模型：alias 不动（配置里本就为空），模型位空着等用户选；MJ 参考分组仍按配方模型路由。
      if (!recipeDraft.model) setModel('');
      const warnings = recipeDraft.config.warnings ?? [];
      const missingModel = recipeDraft.model ? null : recipe.model;
      setRecipeNotice(missingModel || warnings.length > 0 ? { missingModel, warnings } : null);
    } catch (error) {
      if (requestSequence !== reEditSequence.current) return;
      alert(error instanceof Error ? error.message : '参考素材恢复失败');
    }
  }

  // 媒体资产「使用」：按 mime 落到当前模式下真正会被提交的槽位；收不了的类型不取文件，只给一句提示。
  async function addCreationAssetReference(asset: CreationAsset, content: CreationMediaAssetContent) {
    const route = routeStudioMediaAsset(content.mime_type, {
      kind,
      videoMode,
      model,
      videoCaps: kind === 'video' ? videoCaps : null,
      counts: {
        images: referenceImages.length,
        mj: mjRefs.image.length,
        videos: referenceVideos.length,
        audios: referenceAudios.length,
      },
    });
    if ('notice' in route) {
      setAssetNotice(route.notice);
      return;
    }
    try {
      const response = await connectionFetch(creationAssetMediaUrl(asset.asset_id));
      if (!response.ok) throw await apiError(response, '读取媒体资产');
      const blob = await response.blob();
      const file = new File([blob], content.filename, { type: content.mime_type });
      if (route.target === 'frame') setVideoFrames(current => ({ ...current, first: file }));
      else if (route.target === 'mj') setMjRefs(current => ({ ...current, image: [...current.image, file] }));
      else if (route.target === 'videos') setReferenceVideos(current => [...current, file]);
      else if (route.target === 'audios') setReferenceAudios(current => [...current, file]);
      else setReferenceImages(current => [...current, file]);
      setPromptAssetSourceTitle(asset.title);
      setClickPinned(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteFailedRound(jobId: string) {
    const resp = await connectionFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    // 删不掉要说话：静默 return 的话画师点了删除、记录还在，只能当成界面卡了。
    if (!resp.ok) { alert((await apiError(resp, '删除这条失败记录')).message); return; }
    // rounds 是渲染态，persistedJobs 是它的数据源之一：只清 rounds 的话，下一次 SSE 推送
    // 或轮询触发上面那个 mergePersistedRounds 的 effect，这条记录就被合并回来了
    // （后端其实已经删掉，刷新页面才看得出来）。两处一起清。
    setPersistedJobs((jobs) => jobs.filter((j) => j.job_id !== jobId));
    setRounds((items) => items.filter((item) => item.kind !== 'failed' || item.jobId !== jobId));
  }

  async function cancelRound(jobId: string) {
    const resp = await connectionFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    if (!resp.ok) { alert((await apiError(resp, '停止生成')).message); return; }
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
      applyRoundConfig(config, refs);
    } catch (error) {
      if (requestSequence !== reEditSequence.current) return;
      alert(error instanceof Error ? error.message : '参考素材恢复失败');
    }
  }

  // 素材全部取回后再一次性替换编辑器快照（重新编辑 / 复刻共用）；取回失败时调用方不会走到这里，
  // 用户当前编辑内容原样保留。全能参考按实际取回的素材判：复刻时 config 的路径字段是空的。
  function applyRoundConfig(config: RoundConfig, refs: RoundReferenceFiles) {
    const targetKind = config.kind ?? 'image';
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
      setSizeParams({ size_mode: config.sizeMode ?? 'ratio', size: config.size, ratio: config.ratio, resolution: config.resolution, ...(config.sizeMode === 'custom' ? { custom_size: config.size } : {}) });
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
    setPromptAssetSourceTitle(config.sourceAssetTitle ?? null);
  }

  async function regenerate(config: RoundConfig) {
    setRecipeNotice(null);
    if (config.alias) setProviderAlias(config.alias);
    setModel(config.model);
    // 提交本身走 overrideConfig（不依赖表单态）；这里只是把表单同步成原 job 参数，便于继续微调。
    if (config.kind === 'video') {
      if (config.ratio) setVideoRatio(config.ratio);
      if (config.videoResolution) setVideoResolution(config.videoResolution);
      if (config.duration) setDuration(config.duration);
      if (config.videoQuality) setVideoQuality(config.videoQuality);
      if (config.n) setVideoCount(clampImageCount(config.n));
      // 旧 job 的 frame_mode 不回填用户态（提交时按帧数推导）；只同步生成方式：
      // 带视频/音频参考、或参考图没有帧语义（无 frame_mode / auto）→ 全能参考，否则首尾帧。
      setVideoMode(isOmniVideoConfig(config.frameMode, referencePathCounts(config)) ? 'omni' : 'firstlast');
      setGenerateAudio(!!config.generateAudio);
    } else {
      setSizeParams({ size_mode: config.sizeMode ?? 'ratio', size: config.size, ratio: config.ratio, resolution: config.resolution, ...(config.sizeMode === 'custom' ? { custom_size: config.size } : {}) });
      if (config.n) setCount(clampImageCount(config.n));
      if (config.mjParams) setMjParams(config.mjParams);
    }
    await onSubmit(config.prompt, config);
  }

  async function deleteDoneBatch(jobId: string, imagePaths: string[]) {
    const responses = await Promise.all(
      imagePaths.map((path) =>
        connectionFetch(`/api/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
      ),
    );
    const failed = responses.find((resp) => !resp.ok);
    if (failed) { alert((await apiError(failed, '删除这批结果')).message); return; }
    setRounds((items) => items.filter((item) => item.kind !== 'done' || item.jobId !== jobId));
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
      ? mediaUrl(`/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`)
      : /^(characters|studio)\//.test(path) || /\/(characters|studio)\//.test(path)
        ? mediaUrl(`/api/gallery/image?path=${encodeURIComponent(path)}`)
        : mediaUrl(`/api/raw?path=${encodeURIComponent(path)}`);
  const resp = await (url.startsWith('http') ? fetch(url, { credentials: 'omit' }) : connectionFetch(url));
  if (!resp.ok) throw await apiError(resp, `取回参考图（${path}）`);
  const blob = await resp.blob();
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([blob], `${baseName}.${ext}`, { type: blob.type || 'image/png' });
}

function galleryMediaUrl(path: string): string {
  return mediaUrl(`/api/gallery/image?path=${encodeURIComponent(path)}`);
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

function hydrateRoundModelName(round: RoundState, keys: KeyView[]): RoundState {
  const config = round.config;
  if (!config) return round;
  const selectedKey = keys.find((item) => item.alias === config.alias);
  const selectedModel = selectedKey?.models.find((item) => item.id === config.model);
  if (!selectedModel?.name || config.modelName === selectedModel.name) return round;
  return { ...round, config: { ...config, modelName: selectedModel.name } };
}

function studioJobsToRounds(jobs: Job[], keys: KeyView[] = []): RoundState[] {
  return jobs
    .filter((job) => job.status !== 'pending_confirm')
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))
    .flatMap((job): RoundState[] => {
      const mode = deriveGenMode(job);
      if (job.status === 'done') {
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

function frozenGenerationCost(job: Job): number | undefined {
  const actual = job.params?.actual_cost_cny;
  const amount = typeof actual === 'number' && Number.isFinite(actual) && actual >= 0
    ? actual
    : job.params?.estimated_cost_cny;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
    ? amount
    : undefined;
}

function roundKey(round: RoundState): string | null {
  if (round.kind === 'done') return round.jobId;
  if (round.kind === 'failed' && round.jobId) return round.jobId;
  if (round.kind === 'pending' && round.jobId) return round.jobId;
  return null;
}

function mergePersistedRounds(current: RoundState[], persisted: RoundState[]): RoundState[] {
  const persistedKeys = new Set(persisted.map(roundKey).filter((key): key is string => Boolean(key)));
  const localOnly = current.filter((item) => {
    const key = roundKey(item);
    return !key || !persistedKeys.has(key);
  });
  return [...localOnly, ...persisted];
}

function upsertJob(items: Job[], next: Job): Job[] {
  const without = items.filter((item) => item.job_id !== next.job_id);
  return [next, ...without];
}
