import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ChevronsDown } from 'lucide-react';

import { createStudioJob, getStudioJob, listStudioJobs, uploadReferenceImage } from '@/api/studio';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { useSSE, type JobChangedPayload } from '@/hooks/useSSE';
import { PromptInput } from '@/components/studio/PromptInput';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import { RoundList, type RoundConfig, type RoundState } from '@/components/studio/RoundList';
import { StudioQueryBar } from '@/components/studio/StudioQueryBar';
import { studioSizeFor, computeStudioPixelSize, normalizeStudioSizeForModel } from '@/lib/studioSize';
import { imageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import { deriveGenMode, filterRounds, DEFAULT_HISTORY_FILTERS, type HistoryFilters } from '@/lib/historyFilters';
import { fetchGalleryHidden } from '@/api/gallery';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
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
  const [, setLocation] = useLocation();
  const [saved] = useState(loadSelection);
  const [rounds, setRounds] = useState<RoundState[]>([]);
  // 查询面板筛选 + 收藏/隐藏集（渲染端筛选用，state 仍保留全量轮）。setHistoryFilters 喂 StudioQueryBar，
  // toggleFavorite 透传到结果卡 ★ 收藏按钮。
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const { favorites, toggleFavorite } = useGalleryFavorites();
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [persistedJobs, setPersistedJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState(false);
  // compact 模式没有 rounds 列表承接失败卡片，提交/上传错误走这条内联文案。
  const [compactError, setCompactError] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  // 滚动联动收放：历史区 col-reverse（|scrollTop| 即距底距离），>160 收 / <80 展（滞回防抖）。
  // shellFocused / clickPinned 是两个展开覆盖：输入焦点期间恒展开；点击收缩壳展开但不回滚，
  // 再次滚动（dist>160 的 scroll 事件）即取消点击钉住。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [shellFocused, setShellFocused] = useState(false);
  const [clickPinned, setClickPinned] = useState(false);
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
  const [quality, setQuality] = useState<Quality>('low');
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
  }, [kind, model, videoMode, videoRatio, duration, videoResolution, videoQuality]);
  const handleCustomSizeChange = useCallback((w: number, h: number) => {
    setCustomSize(`${w}x${h}`);
  }, []);

  // 点击历史记录里的参考图 → 把这批参考图（服务器路径）拉回成 File[]，整组塞进输入框复用出图。
  const handleReuseReferences = useCallback(async (paths: string[]) => {
    const files = await Promise.all(
      paths.map(async (path, i) => {
        const url = path.startsWith('http') ? path : `/api/raw?path=${encodeURIComponent(path)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`load reference failed: ${resp.status}`);
        const blob = await resp.blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        return new File([blob], `ref-${i + 1}.${ext}`, { type: blob.type || 'image/png' });
      }),
    );
    // 堆叠里混着三类素材：按 MIME 分流回填，视频/音频塞进图片参考会在提交时走错角色。
    setReferenceImages(files.filter((f) => !f.type.startsWith('video/') && !f.type.startsWith('audio/')));
    setReferenceVideos(files.filter((f) => f.type.startsWith('video/')));
    setReferenceAudios(files.filter((f) => f.type.startsWith('audio/')));
  }, []);

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
    enabled: !compact,
    onJobChanged: handleJobChanged,
    onConnect: () => { void refreshPersistedJobs().catch(() => {}); },
  });

  // 隐藏集挂载拉取（收藏集由 useGalleryFavorites 内部自拉）；筛选「隐藏」项时 filterRounds 用。
  useEffect(() => {
    fetchGalleryHidden().then(setHiddenPaths).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!compact) {
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
    }
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
        setModel(savedModelValid ? saved.model! : selected?.models[0]?.id ?? '');
        // 恢复手动自定义尺寸：标准尺寸由 ratio/resolution 自动重算，仅当保存值偏离标准时用 sizeOverride 覆盖。
        if (saved.customSize) {
          const [wStr, hStr] = saved.customSize.split('x');
          const w = parseInt(wStr, 10);
          const h = parseInt(hStr, 10);
          if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            const standard = computeStudioPixelSize(saved.ratio ?? '1:1', saved.resolution ?? '2K', selected?.provider);
            if (w !== standard.w || h !== standard.h) {
              setSizeOverride((prev) => ({ key: (prev?.key ?? 0) + 1, w, h }));
            }
          }
        }
      })
      .catch(() => {
        if (!cancelled) setKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [compact]);

  // 持久化供应商/模型/尺寸/张数等全部选择，切页面再回来时恢复。providerAlias 为空说明 keys 还没加载完，先不写。
  useEffect(() => {
    if (!providerAlias) return;
    saveSelection({
      providerAlias, model, ratio, resolution, count, quality, customSize,
      kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, ratio, resolution, count, quality, customSize,
    kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);

  useEffect(() => {
    if (compact) return;
    setRounds((items) =>
      mergePersistedRounds(
        items.map((item) => hydrateRoundModelName(item, keys)),
        studioJobsToRounds(persistedJobs, keys),
      ),
    );
  }, [compact, keys, persistedJobs]);

  const onSubmit = async (prompt: string, overrideConfig?: RoundConfig) => {
    const wantVideo = overrideConfig ? overrideConfig.kind === 'video' : kind === 'video';
    if (wantVideo) {
      await onSubmitVideo(prompt, overrideConfig);
      return;
    }
    const effectiveRatio = overrideConfig?.ratio ?? ratio;
    const effectiveResolution = overrideConfig?.resolution ?? resolution;
    const effectiveCount = clampImageCount(overrideConfig?.n ?? count);
    const effectiveAlias = overrideConfig?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? model;
    const selectedKey = keys.find((item) => item.alias === effectiveAlias);
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    const caps = imageControlCaps(effectiveModel);
    // nano-banana 的 size 是比例字符串（如 16:9）；gpt-image/standard 是归一化后的像素 WxH。
    const effectiveSize = overrideConfig?.size
      ?? (caps.sizeKind === 'ratio'
        ? effectiveRatio
        : normalizeStudioSizeForModel(
            customSize || studioSizeFor(effectiveRatio, effectiveResolution, effectiveProvider),
            effectiveProvider,
            effectiveModel,
          ));
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);

    setPending(true);
    if (compact) setCompactError(null);
    // 提交前把参考图 File[] 上传到 .runtime/uploads/，拿到服务器路径写进 params.reference_images。
    // 再次生成（overrideConfig）携带的已是服务器路径，直接复用。
    let refPaths: string[];
    try {
      refPaths = overrideConfig?.referenceImages
        ?? (referenceImages.length > 0
          ? await Promise.all(referenceImages.map(uploadReferenceImage))
          : []);
    } catch (e: any) {
      setPending(false);
      if (compact) {
        setCompactError(`参考图上传失败：${e.message}`);
      } else {
        setRounds((rs) => [
          { kind: 'failed', submittedAt: new Date().toISOString(), reason: `参考图上传失败：${e.message}` },
          ...rs,
        ]);
      }
      return;
    }

    const config: RoundConfig = {
      prompt,
      alias: effectiveAlias,
      provider: effectiveProvider,
      model: effectiveModel,
      modelName: selectedModel?.name ?? overrideConfig?.modelName,
      ratio: effectiveRatio,
      resolution: effectiveResolution,
      size: effectiveSize,
      n: effectiveCount,
      quality: overrideConfig?.quality ?? quality,
      referenceImages: refPaths,
    };
    const jobParams: JobParams = {
      size: effectiveSize,
      ratio: effectiveRatio,
      resolution: effectiveResolution,
      n: effectiveCount,
      quality: overrideConfig?.quality ?? quality,
      ...(refPaths.length > 0 ? { reference_images: refPaths } : {}),
    };

    if (compact) {
      try {
        await createStudioJob({
          prompt,
          alias: effectiveAlias ?? undefined,
          model: effectiveModel,
          params: jobParams,
        });
        setLocation('/studio');
      } catch (e: any) {
        setCompactError(`提交失败：${e.message}`);
      } finally {
        setPending(false);
      }
      return;
    }

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
    if (compact) setCompactError(null);
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
      if (compact) {
        setCompactError(`参考资产上传失败：${e.message}`);
      } else {
        setRounds((rs) => [
          { kind: 'failed', submittedAt: new Date().toISOString(), reason: `参考资产上传失败：${e.message}` },
          ...rs,
        ]);
      }
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

    if (compact) {
      try {
        await createStudioJob({
          prompt,
          alias: effectiveAlias ?? undefined,
          model: effectiveModel,
          params: videoParams,
          kind: 'video',
        });
        setLocation('/studio');
      } catch (e: any) {
        // compact 模式没有 rounds 列表可挂失败卡片，错误必须有内联出口，否则用户只看到"点了没反应"。
        setCompactError(`提交失败：${e.message}`);
      } finally {
        setPending(false);
      }
      return;
    }

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

  if (compact) {
    return (
      <div className="py-8" aria-label="生图沙箱">
        <h1 className="font-display text-display leading-tight mb-6 sm:mb-8 max-w-[780px] mx-auto">
          描述你想生成的图片
        </h1>
        <PromptInput
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
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
          onCountChange={setCount}
          onQualityChange={setQuality}
          onCustomSizeChange={handleCustomSizeChange}
          sizeOverride={sizeOverride}
          menuDirection="down"
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
        {compactError && (
          <p role="alert" className="mt-3 max-w-[780px] mx-auto text-sm text-destructive">
            {compactError}
          </p>
        )}
      </div>
    );
  }

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
        data-testid="studio-history-scroll"
        className="flex h-full flex-col-reverse overflow-y-auto pt-20 pb-[210px]"
      >
        <RoundList
          rounds={reversedRounds}
          favorites={favorites}
          onToggleFavorite={toggleFavorite}
          onDeleteFailed={deleteFailedRound}
          onReEdit={reEdit}
          onRegenerate={regenerate}
          onDeleteBatch={deleteDoneBatch}
          onReuseReferences={handleReuseReferences}
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
    </div>
  );

  async function deleteFailedRound(jobId: string) {
    const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    if (!resp.ok) return;
    setRounds((items) => items.filter((item) => item.kind !== 'failed' || item.jobId !== jobId));
  }

  function reEdit(config: RoundConfig) {
    setPromptText(config.prompt);
    if (config.alias) setProviderAlias(config.alias);
    setModel(config.model);
    if (config.ratio) setRatio(config.ratio);
    if (config.resolution) setResolution(config.resolution);
    if (config.n) setCount(clampImageCount(config.n));
    if (config.quality) setQuality(config.quality);
    if (config.size) {
      const [wStr, hStr] = config.size.split('x');
      const w = parseInt(wStr, 10);
      const h = parseInt(hStr, 10);
      if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
        const standard = computeStudioPixelSize(config.ratio ?? ratio, config.resolution ?? resolution, config.provider);
        if (w !== standard.w || h !== standard.h) {
          setSizeOverride((prev) => ({ key: (prev?.key ?? 0) + 1, w, h }));
        }
      }
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
      const omniLike = Boolean(
        config.referenceVideos?.length
        || config.referenceAudios?.length
        || (config.referenceImages?.length && (!config.frameMode || config.frameMode === 'auto')),
      );
      setVideoMode(omniLike ? 'omni' : 'firstlast');
      setGenerateAudio(!!config.generateAudio);
    } else {
      if (config.ratio) setRatio(config.ratio);
      if (config.resolution) setResolution(config.resolution);
      if (config.n) setCount(clampImageCount(config.n));
    }
    await onSubmit(config.prompt, config);
  }

  async function deleteDoneBatch(jobId: string, imagePaths: string[]) {
    const responses = await Promise.all(
      imagePaths.map((path) =>
        fetch(`/api/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
      ),
    );
    if (responses.some((resp) => !resp.ok)) return;
    setRounds((items) => items.filter((item) => item.kind !== 'done' || item.jobId !== jobId));
  }
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

function pathList(value: unknown): string[] {
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
    // 视频参数：再次生成时从原 job 还原（resolution 上面只认 2K/4K 图片语义，视频的 720p/1080p 存这里）。
    // referenceVideos/Audios 给空数组而非 undefined，避免 onSubmitVideo 的 ?? 回落到当前表单文件。
    ...(isVideo
      ? {
          duration: typeof p.duration === 'number' ? p.duration : undefined,
          videoResolution: typeof p.resolution === 'string' ? p.resolution : undefined,
          videoQuality: (p.mode === 'std' || p.mode === 'pro') ? p.mode : undefined,
          frameMode: p.frame_mode,
          generateAudio: p.generate_audio === true,
          referenceVideos: pathList(p.reference_videos),
          referenceAudios: pathList(p.reference_audios),
        }
      : {}),
  };
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
          imagePaths: job.output_paths,
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
