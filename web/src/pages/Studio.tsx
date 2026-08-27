import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { ChevronsDown } from 'lucide-react';

import { createStudioJob, getStudioJob, listStudioJobs, resolveImageReferencePaths, uploadReferenceImage } from '@/api/studio';
import { apiError } from '@/api/http';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { useSSE, type JobChangedPayload } from '@/hooks/useSSE';
import { PromptInput } from '@/components/studio/PromptInput';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import { EMPTY_MJ_REFS, routeReusedImageFiles, type MjRefSlots } from '@/components/studio/MjReferenceSlots';
import { RoundList, type RoundConfig, type RoundState } from '@/components/studio/RoundList';
import { StudioQueryBar } from '@/components/studio/StudioQueryBar';
import { StudioArchiveDialog, type StudioArchiveRequest } from '@/components/studio/StudioArchiveDialog';
import { studioSizeFor, computeStudioPixelSize, normalizeStudioSizeForModel } from '@/lib/studioSize';
import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import { imageFamily } from '@/lib/modelFamily';
import { MJ_DEFAULTS, mjParamsFromJob, mjParamsToJob, type MjParams } from '@/lib/mjParams';
import { videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import { deriveGenMode, filterRounds, DEFAULT_HISTORY_FILTERS, type HistoryFilters } from '@/lib/historyFilters';
import { estimateGenerationCost } from '@/lib/generationCost';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { useGalleryHidden } from '@/hooks/useGalleryHidden';
import { StudioCompact } from './StudioCompact';
import type { Job, JobKind, JobParams } from '@/schema/jobs';

const SELECTION_STORAGE_KEY = 'studio:selection';

interface SavedSelection {
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  count?: number;
  quality?: Quality;
  customSize?: string;
  /** 尺寸是用户亲手改的，不是自动算出来的。缺失按 false。 */
  customSizeManual?: boolean;
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
  const [rounds, setRounds] = useState<RoundState[]>([]);
  // 查询面板筛选 + 收藏/隐藏集（渲染端筛选用，state 仍保留全量轮）。setHistoryFilters 喂 StudioQueryBar，
  // toggleFavorite 透传到结果卡 ★ 收藏按钮。
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const { favorites, toggleFavorite } = useGalleryFavorites();
  const { hiddenPaths, toggleHidden } = useGalleryHidden();
  const [persistedJobs, setPersistedJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState(false);
  const [keys, setKeys] = useState<KeyView[]>([]);
  // 滚动联动收放：历史区 col-reverse（|scrollTop| 即距底距离），>160 收 / <80 展（滞回防抖）。
  // shellFocused / clickPinned 是两个展开覆盖：输入焦点期间恒展开；点击收缩壳展开但不回滚，
  // 再次滚动（dist>160 的 scroll 事件）即取消点击钉住。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [shellFocused, setShellFocused] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
  const [reuseLimitNotice, setReuseLimitNotice] = useState(false);
  const [archiveRequest, setArchiveRequest] = useState<StudioArchiveRequest | null>(null);
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
  // 出图配置每次启动回默认（飙哥指定）：不从 localStorage 回填 ratio/像素/质量/数量，
  // 每次重启网站都是 1:1 + 默认像素（2K 档算）+ low（仅区分质量的模型显示）+ 1 张。
  // provider/model 仍按 saved 恢复（见下方 listKeys 后的恢复逻辑），只重置这 4+1 个配置项。
  const [ratio, setRatio] = useState('1:1');
  const [resolution, setResolution] = useState<'2K' | '4K'>('2K');
  const [count, setCount] = useState(1);
  const [customSize, setCustomSize] = useState('');
  const [customSizeManual, setCustomSizeManual] = useState(false);
  const [quality, setQuality] = useState<Quality>('low');
  // MJ 参数不进 localStorage —— 与 ratio/像素/质量/数量 同一政策：出图配置每次启动回默认。
  const [mjParams, setMjParams] = useState<MjParams>(MJ_DEFAULTS);
  // MJ 四个语义参考组；每组允许多图，垫图最终仍落 reference_images。
  const [mjRefs, setMjRefs] = useState<MjRefSlots>(EMPTY_MJ_REFS);
  const [sizeOverride, setSizeOverride] = useState<{ key: number; w: number; h: number } | undefined>(undefined);
  const [promptText, setPromptText] = useState('');
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [kind, setKind] = useState<JobKind>(saved.kind ?? 'image');
  // 旧版本 videoMode 存过 t2v/i2v/ref/v2v —— 仅 'omni' 原样保留，其余一律回落首尾帧。
  const [videoMode, setVideoMode] = useState<VideoMode>(saved.videoMode === 'omni' ? 'omni' : 'firstlast');
  const [duration, setDuration] = useState<number>(saved.duration ?? 5);
  const [videoResolution, setVideoResolution] = useState<string>(saved.videoResolution ?? '720p');
  const [videoRatio, setVideoRatio] = useState<string>(saved.videoRatio ?? '16:9');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(saved.videoQuality === 'pro' ? 'pro' : 'std');
  const [videoCount, setVideoCount] = useState<number>(clampImageCount(saved.videoCount ?? 1));
  const [generateAudio, setGenerateAudio] = useState<boolean>(saved.generateAudio ?? false);
  const [referenceVideos, setReferenceVideos] = useState<File[]>([]);
  const [referenceAudios, setReferenceAudios] = useState<File[]>([]);
  // 首尾帧模式的双槽（与 referenceImages 分离：两个槽各自独立可空，仅尾帧也合法）。
  const [videoFrames, setVideoFrames] = useState<FrameSlots>({ first: null, last: null });
  // 重新编辑会异步拉取历史参考素材；只允许最后一次点击的结果回填，避免慢请求覆盖新选择。
  const reEditSequence = useRef(0);
  const selectedModelObj = keys.find((k) => k.alias === providerAlias)?.models.find((m) => m.id === model);
  const videoCaps = videoControlCaps(model, selectedModelObj?.protocol);
  // 切到视频模式时，若当前 key 没有视频模型，自动选中首个带视频模型的 key —— 让 videoCaps 立即正确（否则退化成 STANDARD_CAPS）。
  useEffect(() => {
    if (kind !== 'video' || keys.length === 0) return;
    const videoModelsOf = (k: KeyView) => (k.models ?? []).filter((m) => modelModality(m, k) === 'video');
    const cur = keys.find((k) => k.alias === providerAlias);
    if (cur && videoModelsOf(cur).length > 0) return;
    const v = keys.find((k) => videoModelsOf(k).length > 0);
    if (v) {
      setProviderAlias(v.alias);
      setModel(videoModelsOf(v)[0]?.id ?? '');
    }
    // 仅在切到视频模式 / keys 加载时触发；providerAlias 不入依赖，避免用户改回非视频 key 时被反复抢选成死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, keys]);
  // 切换视频模型族时把超出 caps 的选择拉回合法值（如 seedance 21:9 → kling 没有；kling 档位 ↔ seedance 无档位）。
  useEffect(() => {
    if (kind !== 'video') return;
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
  // manual 由 PromptInput 给：只有亲手改宽高输入框才是 true，切比例/档位/模型的
  // 自动重算是 false。存进 saveSelection 后，下次恢复不必再靠比对数值去猜意图。
  const handleCustomSizeChange = useCallback((w: number, h: number, manual?: boolean) => {
    setCustomSize(`${w}x${h}`);
    setCustomSizeManual(Boolean(manual));
  }, []);

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
        const savedKey = saved.providerAlias
          ? usable.find((key) => key.alias === saved.providerAlias)
          : undefined;
        const selected = savedKey ?? usable[0];
        setProviderAlias(selected?.alias ?? '');
        const savedModelValid = saved.model && selected?.models.some((m) => m.id === saved.model);
        const nextModel = savedModelValid ? saved.model! : selected?.models[0]?.id ?? '';
        setModel(nextModel);
        // 恢复手动自定义尺寸：标准尺寸由 ratio/resolution 自动重算，仅当保存值偏离标准时用 sizeOverride 覆盖。
        // 只恢复用户**亲手改过**的尺寸，凭存档里的 customSizeManual 标记判断。
        // 旧代码拿存档值和「当前」标准尺寸比，不等就当手动覆盖 —— 标准尺寸公式一改
        // （PR #40 把 pro 的 2K 从 2048² 撑到上限 2150²），历史存档里那个曾经标准的
        // 2048² 就被追认成手动选择：打开就显示 2048×2048，点一下比例才跳回 2150×2150，
        // 期间出的图真按 2048² 出，白丢约 10% 像素。缺标记的旧存档按「非手动」处理，
        // 回落到标准尺寸 —— 这个方向错了只是丢一次自定义值，反过来错则天天出小图。
        if (saved.customSizeManual && saved.customSize) {
          const [wStr, hStr] = saved.customSize.split('x');
          const w = parseInt(wStr, 10);
          const h = parseInt(hStr, 10);
          if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            setSizeOverride((prev) => ({ key: (prev?.key ?? 0) + 1, w, h }));
          }
        }
      })
      .catch(() => {
        if (!cancelled) setKeys([]);
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
      providerAlias, model, ratio, resolution, count, quality, customSize, customSizeManual,
      kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, ratio, resolution, count, quality, customSize, customSizeManual,
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

  const onSubmit = async (prompt: string, overrideConfig?: RoundConfig) => {
    const wantVideo = overrideConfig ? overrideConfig.kind === 'video' : kind === 'video';
    if (wantVideo) {
      await onSubmitVideo(prompt, overrideConfig);
      return;
    }
    const effectiveRatio = overrideConfig?.ratio ?? ratio;
    const effectiveResolution = overrideConfig?.resolution ?? resolution;
    const effectiveAlias = overrideConfig?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? model;
    const selectedKey = keys.find((item) => item.alias === effectiveAlias);
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    // 能力按模型族判；provider 只在 openrouter 上改 size 语义（比例串而非像素）。
    const caps = imageControlCaps(effectiveModel, effectiveProvider);
    // MJ 一次 imagine 固定回 4 张方案，张数不由画师定（见 MJ_IMAGES_PER_TASK）。
    const effectiveCount = caps.family === 'midjourney'
      ? MJ_IMAGES_PER_TASK
      : clampImageCount(overrideConfig?.n ?? count);
    // nano-banana / openrouter 的 size 是比例字符串（如 16:9）；其余是归一化后的像素 WxH。
    // MJ（sizeKind='none'）一个尺寸参数都不发：比例由渠道锁定在 1:1，写了也只是自欺。
    const effectiveSize = overrideConfig?.size
      ?? (caps.sizeKind === 'none'
        ? undefined
        : caps.sizeKind === 'ratio'
          ? effectiveRatio
          : normalizeStudioSizeForModel(
              customSize || studioSizeFor(effectiveRatio, effectiveResolution, effectiveModel),
              effectiveModel,
            ));
    // 质量档位只在该族真有时才发：seedream / dall-e 不认 low|high，nano-banana 不认 auto。
    const rawQuality = overrideConfig?.quality ?? quality;
    const effectiveQuality = caps.qualities?.includes(rawQuality) ? rawQuality : undefined;
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);

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
      n: effectiveCount,
      quality: effectiveQuality,
      referenceImages: refPaths,
      ...(caps.family === 'midjourney'
        ? { mjParams: overrideConfig?.mjParams ?? mjParams, mjRefPaths }
        : {}),
    };
    // 控件隐藏的参数一律不写进 params（与视频侧同写法）：后端 openrouter_image 会把
    // params.resolution 原样当 API 参数发出去，在别的 key 上选过 4K 就会被带过来按 4K 计费。
    const jobParams: JobParams = {
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(caps.ratios.length > 0 ? { ratio: effectiveRatio } : {}),
      ...(caps.showResolution ? { resolution: effectiveResolution } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { quality: effectiveQuality } : {}),
      ...(refPaths.length > 0 ? { reference_images: refPaths } : {}),
      // MJ 的一切控制都在 prompt flag 里，由后端 mj_image 拼接；这里只发结构化值。
      ...(caps.family === 'midjourney'
        ? {
            ...mjParamsToJob(overrideConfig?.mjParams ?? mjParams),
            ...(mjRefPaths.sref ? { mj_sref: mjRefPaths.sref } : {}),
            ...(mjRefPaths.cref ? { mj_cref: mjRefPaths.cref } : {}),
            ...(mjRefPaths.oref ? { mj_oref: mjRefPaths.oref } : {}),
          }
        : {}),
    };
    const estimatedCost = generationCostForSubmission(
      selectedKey,
      effectiveModel,
      'image',
      jobParams,
    );
    if (estimatedCost != null) jobParams.estimated_cost_cny = estimatedCost;

    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, config };
    setRounds((rs) => [myRound, ...rs]);
    // 新一轮提交后跳回底部（col-reverse 的底即 0），让用户看到 pending 卡片。
    scrollToBottom();

    let job: Job;
    try {
      job = await createStudioJob({
        prompt,
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

  const onSubmitVideo = async (prompt: string, overrideConfig?: RoundConfig) => {
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
    };
    const estimatedCost = generationCostForSubmission(
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
          onReEdit={reEdit}
          onRegenerate={regenerate}
          onDeleteBatch={deleteDoneBatch}
          onReuseReferences={handleReuseReferences}
          onEditAsReference={handleEditAsReference}
          onArchive={(jobId, path, mediaKind) => setArchiveRequest({ jobId, path, mediaKind })}
        />
      </div>
      {/* 浮层输入：wrapper 不收事件，两侧视觉与交互都穿透到历史区；壳本体在 PromptInput 内
          pointer-events-auto。 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 px-3 sm:px-6">
        <div className="relative mx-auto max-w-[780px]">
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
        {reuseLimitNotice && (
          <span
            role="status"
            className="absolute bottom-full left-0 mb-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
          >
            历史参考图超过 MJ 每槽 4 张，已保留前 4 张
          </span>
        )}
        <PromptInput
          collapsed={dockCollapsed}
          onExpandRequest={() => setClickPinned(true)}
          onShellFocusChange={setShellFocused}
          onSubmit={onSubmit}
          disabled={pending}
          value={promptText}
          onValueChange={setPromptText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          count={count}
          quality={quality}
          mjParams={mjParams}
          onMjParamsChange={(patch) => setMjParams((prev) => ({ ...prev, ...patch }))}
          mjRefs={mjRefs}
          onMjRefsChange={setMjRefs}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
          onCountChange={setCount}
          onQualityChange={setQuality}
          onCustomSizeChange={handleCustomSizeChange}
          sizeOverride={sizeOverride}
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
      </div>
      <StudioArchiveDialog request={archiveRequest} onClose={() => setArchiveRequest(null)} />
    </div>
  );

  async function deleteFailedRound(jobId: string) {
    const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    // 删不掉要说话：静默 return 的话画师点了删除、记录还在，只能当成界面卡了。
    if (!resp.ok) { alert((await apiError(resp, '删除这条失败记录')).message); return; }
    // rounds 是渲染态，persistedJobs 是它的数据源之一：只清 rounds 的话，下一次 SSE 推送
    // 或轮询触发上面那个 mergePersistedRounds 的 effect，这条记录就被合并回来了
    // （后端其实已经删掉，刷新页面才看得出来）。两处一起清。
    setPersistedJobs((jobs) => jobs.filter((j) => j.job_id !== jobId));
    setRounds((items) => items.filter((item) => item.kind !== 'failed' || item.jobId !== jobId));
  }

  async function reEdit(config: RoundConfig, jobId?: string) {
    const requestSequence = ++reEditSequence.current;
    const targetKind = config.kind ?? 'image';
    setClickPinned(true);
    try {
      const refs = await fetchRoundReferences(config, jobId);
      if (requestSequence !== reEditSequence.current) return;

      // 素材全部取回后再一次性替换编辑器快照；任何素材失败都保留用户当前编辑内容。
      setKind(targetKind);
      if (config.alias) setProviderAlias(config.alias);
      setModel(config.model);
      if (targetKind === 'video') {
        if (config.ratio) setVideoRatio(config.ratio);
        if (config.videoResolution) setVideoResolution(config.videoResolution);
        if (config.duration) setDuration(config.duration);
        if (config.videoQuality) setVideoQuality(config.videoQuality);
        if (config.n) setVideoCount(clampImageCount(config.n));
        setVideoMode(isOmniVideoConfig(config) ? 'omni' : 'firstlast');
        setGenerateAudio(!!config.generateAudio);
      } else {
        if (config.ratio) setRatio(config.ratio);
        if (config.resolution) setResolution(config.resolution);
        if (config.n) setCount(clampImageCount(config.n));
        if (config.quality) setQuality(config.quality);
        if (config.mjParams) setMjParams(config.mjParams);
        if (config.size) {
          const [wStr, hStr] = config.size.split('x');
          const w = parseInt(wStr, 10);
          const h = parseInt(hStr, 10);
          if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            const standard = computeStudioPixelSize(config.ratio ?? ratio, config.resolution ?? resolution, config.model);
            if (w !== standard.w || h !== standard.h) {
              setSizeOverride((prev) => ({ key: (prev?.key ?? 0) + 1, w, h }));
            }
          }
        }
      }

      setReferenceImages([]);
      setReferenceVideos([]);
      setReferenceAudios([]);
      setVideoFrames({ first: null, last: null });
      setMjRefs(EMPTY_MJ_REFS);
      if (targetKind === 'video') {
        if (isOmniVideoConfig(config)) {
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
    } catch (error) {
      if (requestSequence !== reEditSequence.current) return;
      alert(error instanceof Error ? error.message : '参考素材恢复失败');
    }
  }

  async function regenerate(config: RoundConfig) {
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
      setVideoMode(isOmniVideoConfig(config) ? 'omni' : 'firstlast');
      setGenerateAudio(!!config.generateAudio);
    } else {
      if (config.ratio) setRatio(config.ratio);
      if (config.resolution) setResolution(config.resolution);
      if (config.n) setCount(clampImageCount(config.n));
      if (config.mjParams) setMjParams(config.mjParams);
    }
    await onSubmit(config.prompt, config);
  }

  async function deleteDoneBatch(jobId: string, imagePaths: string[]) {
    const responses = await Promise.all(
      imagePaths.map((path) =>
        fetch(`/api/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
      ),
    );
    const failed = responses.find((resp) => !resp.ok);
    if (failed) { alert((await apiError(failed, '删除这批结果')).message); return; }
    setRounds((items) => items.filter((item) => item.kind !== 'done' || item.jobId !== jobId));
  }
}

// 服务器资产路径 → File。三类来源分流字节端点（与 RoundList 的 refImageSrc 同规则）：
// http(s) 直链原样取；characters/studio 资产走 /api/gallery/image（/api/raw 不带 job_id
// 只放行 .runtime/uploads/，角色/出图产物会 403）；其余临时上传走 /api/raw。
async function fetchAssetAsFile(path: string, baseName: string, jobId?: string): Promise<File> {
  const url = path.startsWith('http')
    ? path
    : jobId
      ? `/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`
      : /^(characters|studio)\//.test(path) || /\/(characters|studio)\//.test(path)
        ? `/api/gallery/image?path=${encodeURIComponent(path)}`
        : `/api/raw?path=${encodeURIComponent(path)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw await apiError(resp, `取回参考图（${path}）`);
  const blob = await resp.blob();
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([blob], `${baseName}.${ext}`, { type: blob.type || 'image/png' });
}

async function fetchRoundReferences(config: RoundConfig, jobId?: string) {
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

function isOmniVideoConfig(config: RoundConfig): boolean {
  return Boolean(
    config.referenceVideos?.length
    || config.referenceAudios?.length
    || (config.referenceImages.length && (!config.frameMode || config.frameMode === 'auto'))
  );
}

function referenceImagesFor(job: Job): string[] {
  const params = job.params ?? {};
  const refs = [
    job.source_image,
    ...(Array.isArray(params.reference_images) ? params.reference_images : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  // 同一资产可能因 data root 迁移（旧仓 game-ui-ai-workflow → 分离后的 game-atelier）以不同前缀
  // 重复登记：source_image 存新路径（可渲染）、reference_images 仍是旧仓路径（文件已不在 → 裂图）。
  // 按尾段（角色/槽位/文件名）去重并保留首个（source_image 在前＝有效路径），消除历史里
  // 「一张有效 + 一张裂图」的重复缩略图。本地上传走 .runtime/uploads/<uuid> 尾段唯一，不会误并。
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    const key = ref.startsWith('http') ? ref : ref.split('/').slice(-3).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function configForJob(job: Job, keys: KeyView[] = []): RoundConfig {
  const selectedKey = keys.find((item) => item.alias === job.alias);
  const selectedModel = selectedKey?.models.find((item) => item.id === job.model);
  const isVideo = job.kind === 'video';
  // 记录统一后更多 job 流经此处（含 skill 出图 / 乐观提交回包），params 缺省给 {} 兜底，免渲染期崩溃。
  const p = job.params ?? {};
  return {
    prompt: job.prompt ?? '',
    kind: isVideo ? 'video' : 'image',
    alias: job.alias,
    provider: job.provider,
    model: job.model,
    modelName: selectedModel?.name,
    ratio: typeof p.ratio === 'string' ? p.ratio : undefined,
    resolution: p.resolution === '4K' ? '4K' : p.resolution === '2K' ? '2K' : undefined,
    size: typeof p.size === 'string' ? p.size : undefined,
    n: typeof p.n === 'number' ? clampImageCount(p.n) : undefined,
    quality: (p.quality === 'low' || p.quality === 'medium'
      || p.quality === 'high' || p.quality === 'auto')
      ? p.quality
      : undefined,
    referenceImages: referenceImagesFor(job),
    // 后端跑 job 时回写的静默改写提示（尺寸归一化 / 参考图截断）——两端 schema 早有此字段。
    warnings: stringList(p.warnings),
    // MJ 参数从 job 还原：编辑导入 / 再次生成不带上就等于拿默认值重出一张不一样的图。
    ...(imageFamily(job.model) === 'midjourney'
      ? {
          mjParams: mjParamsFromJob(p),
          mjFlags: typeof p.mj_flags === 'string' ? p.mj_flags : undefined,
          mjRefPaths: {
            sref: stringList(p.mj_sref),
            cref: stringList(p.mj_cref),
            oref: stringList(p.mj_oref),
          },
        }
      : {}),
    // 视频参数：再次生成时从原 job 还原（resolution 上面只认 2K/4K 图片语义，视频的 720p/1080p 存这里）。
    // referenceVideos/Audios 给空数组而非 undefined，避免 onSubmitVideo 的 ?? 回落到当前表单文件。
    ...(isVideo
      ? {
          duration: typeof p.duration === 'number' ? p.duration : undefined,
          videoResolution: typeof p.resolution === 'string' ? p.resolution : undefined,
          videoQuality: (p.mode === 'std' || p.mode === 'pro') ? p.mode : undefined,
          frameMode: p.frame_mode,
          generateAudio: p.generate_audio === true,
          referenceVideos: stringList(p.reference_videos),
          referenceAudios: stringList(p.reference_audios),
        }
      : {}),
  };
}

function generationCostForSubmission(
  selectedKey: KeyView | undefined,
  modelId: string,
  kind: 'image' | 'video',
  params: JobParams,
): number | null {
  if (!selectedKey) return null;
  const selectedModel = selectedKey.models.find((item) => item.id === modelId);
  const p = params ?? {};
  const quality = (p.quality === 'low' || p.quality === 'medium'
    || p.quality === 'high' || p.quality === 'auto')
    ? p.quality
    : undefined;
  return estimateGenerationCost({
    provider: {
      provider: selectedKey.provider,
      baseUrl: selectedKey.base_url,
    },
    model: { id: modelId, protocol: selectedModel?.protocol },
    kind,
    count: typeof p.n === 'number' ? p.n : undefined,
    quality,
    duration: typeof p.duration === 'number' ? p.duration : undefined,
    resolution: typeof p.resolution === 'string' ? p.resolution : undefined,
    ratio: typeof p.ratio === 'string' ? p.ratio : undefined,
    generateAudio: p.generate_audio === true,
    hasReferenceVideo: stringList(p.reference_videos).length > 0,
  });
}

function clampImageCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? 1), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(4, Math.max(1, Math.floor(parsed)));
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
          generationCost: frozenGenerationCost(job),
          config: configForJob(job, keys),
        }];
      }
      if (job.status === 'failed') {
        return [{
          kind: 'failed' as const,
          mode,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          reason: job.error ?? '生成失败',
          config: configForJob(job, keys),
        }];
      }
      return [{
        kind: 'pending' as const,
        mode,
        jobId: job.job_id,
        startedAt: Date.parse(job.submitted_at) || Date.now(),
        progressPhase: job.progress_phase ?? null,
        config: configForJob(job, keys),
      }];
    });
}

function frozenGenerationCost(job: Job): number | undefined {
  const amount = job.params?.estimated_cost_cny;
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
