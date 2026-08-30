import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';

import { createStudioJob, resolveImageReferencePaths, uploadReferenceImage } from '@/api/studio';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { PromptInput } from '@/components/studio/PromptInput';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import type { RoundConfig } from '@/components/studio/RoundList';
import { normalizeStudioSizeForModel, studioSizeFor } from '@/lib/studioSize';
import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import { hasSrefCode, MJ_DEFAULTS, mjParamsToJob, type MjParams } from '@/lib/mjParams';
import { EMPTY_MJ_REFS, type MjRefSlots } from '@/components/studio/MjReferenceSlots';
import { videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import type { JobKind, JobParams } from '@/schema/jobs';

const SELECTION_STORAGE_KEY = 'studio:selection';

interface SavedSelection {
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
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
    // localStorage 不可用时不影响首页输入。
  }
}

export function StudioCompact() {
  const [, setLocation] = useLocation();
  const [saved] = useState(loadSelection);
  const [pending, setPending] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  const [ratio, setRatio] = useState('1:1');
  const [resolution, setResolution] = useState<'2K' | '4K'>('2K');
  const [count, setCount] = useState(1);
  const [customSize, setCustomSize] = useState('');
  const [customSizeManual, setCustomSizeManual] = useState(false);
  const [quality, setQuality] = useState<Quality>('low');
  // 与 StudioFull 同一政策：MJ 参数不进 localStorage，每次启动回默认。
  const [mjParams, setMjParams] = useState<MjParams>(MJ_DEFAULTS);
  const [mjRefs, setMjRefs] = useState<MjRefSlots>(EMPTY_MJ_REFS);
  const [sizeOverride, setSizeOverride] = useState<{ key: number; w: number; h: number } | undefined>(undefined);
  const [promptText, setPromptText] = useState('');
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [kind, setKind] = useState<JobKind>(saved.kind ?? 'image');
  const [videoMode, setVideoMode] = useState<VideoMode>(saved.videoMode === 'omni' ? 'omni' : 'firstlast');
  const [duration, setDuration] = useState<number>(saved.duration ?? 5);
  const [videoResolution, setVideoResolution] = useState<string>(saved.videoResolution ?? '720p');
  const [videoRatio, setVideoRatio] = useState<string>(saved.videoRatio ?? '16:9');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(saved.videoQuality === 'pro' ? 'pro' : 'std');
  const [videoCount, setVideoCount] = useState<number>(clampImageCount(saved.videoCount ?? 1));
  const [generateAudio, setGenerateAudio] = useState<boolean>(saved.generateAudio ?? false);
  const [referenceVideos, setReferenceVideos] = useState<File[]>([]);
  const [referenceAudios, setReferenceAudios] = useState<File[]>([]);
  const [videoFrames, setVideoFrames] = useState<FrameSlots>({ first: null, last: null });
  const selectedModelObj = keys.find((k) => k.alias === providerAlias)?.models.find((m) => m.id === model);
  const videoCaps = videoControlCaps(model, selectedModelObj?.protocol);

  useEffect(() => {
    let cancelled = false;
    listKeys()
      .then((resp) => {
        if (cancelled) return;
        const usable = resp.keys.filter((key) => key.models.length > 0);
        setKeys(usable);
        const savedKey = saved.providerAlias
          ? usable.find((key) => key.alias === saved.providerAlias)
          : undefined;
        const selected = savedKey ?? usable[0];
        setProviderAlias(selected?.alias ?? '');
        const savedModelValid = saved.model && selected?.models.some((m) => m.id === saved.model);
        const nextModel = savedModelValid ? saved.model! : selected?.models[0]?.id ?? '';
        setModel(nextModel);
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
  }, [saved]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, keys]);

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
  }, [kind, model, videoMode, videoRatio, duration, videoResolution, videoQuality, keys, providerAlias]);

  useEffect(() => {
    if (!providerAlias) return;
    saveSelection({
      providerAlias, model, ratio, resolution, quality, customSize, customSizeManual,
      kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, ratio, resolution, quality, customSize, customSizeManual,
    kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);

  // manual 由 PromptInput 给：只有亲手改宽高输入框才是 true，切比例/档位/模型的
  // 自动重算是 false。存进 saveSelection 后，下次恢复不必再靠比对数值去猜意图。
  const handleCustomSizeChange = useCallback((w: number, h: number, manual?: boolean) => {
    setCustomSize(`${w}x${h}`);
    setCustomSizeManual(Boolean(manual));
  }, []);

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
    // 与 Studio.onSubmit 同一套判据：能力按模型族，provider 只在 openrouter 上改 size 语义。
    const caps = imageControlCaps(
      effectiveModel,
      effectiveProvider,
      selectedKey?.models.find((item) => item.id === effectiveModel)?.protocol,
      selectedKey?.base_url,
    );
    // MJ 一次 imagine 固定回 4 张方案（同 Studio.onSubmit）。
    const effectiveCount = caps.family === 'midjourney'
      ? MJ_IMAGES_PER_TASK
      : clampImageCount(overrideConfig?.n ?? count);
    // MJ（sizeKind='none'）不发任何尺寸参数：比例由渠道锁定在 1:1。
    const effectiveSize = overrideConfig?.size
      ?? (caps.sizeKind === 'none'
        ? undefined
        : caps.sizeKind === 'ratio'
          ? effectiveRatio
          : normalizeStudioSizeForModel(
              customSize || studioSizeFor(effectiveRatio, effectiveResolution, effectiveModel),
              effectiveModel,
            ));
    const rawQuality = overrideConfig?.quality ?? quality;
    const effectiveQuality = caps.qualities?.includes(rawQuality) ? rawQuality : undefined;
    const effectiveMjParams = overrideConfig?.mjParams ?? mjParams;

    setPending(true);
    setCompactError(null);
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
      setCompactError(e.message);
      return;
    }

    // 控件隐藏的参数不写进 params（同 Studio.onSubmit）：openrouter 会把 resolution 当 API 参数发。
    const jobParams: JobParams = {
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(caps.ratios.length > 0 ? { ratio: effectiveRatio } : {}),
      ...(caps.showResolution ? { resolution: effectiveResolution } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { quality: effectiveQuality } : {}),
      ...(refPaths.length > 0 ? { reference_images: refPaths } : {}),
      // MJ 的控制全在 prompt flag 里，由后端 mj_image 拼接（同 StudioFull）。
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
    if (estimatedCost != null) jobParams.estimated_cost_cny = estimatedCost;

    try {
      await createStudioJob({
        prompt,
        alias: effectiveAlias ?? undefined,
        model: effectiveModel,
        params: jobParams,
      });
      setLocation('/studio');
    } catch (e: any) {
      setCompactError(e.message);
    } finally {
      setPending(false);
    }
  };

  const onSubmitVideo = async (prompt: string, overrideConfig?: RoundConfig) => {
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
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);
    const effectiveCaps = videoControlCaps(effectiveModel, selectedModel?.protocol);

    setPending(true);
    setCompactError(null);
    let imgPaths: string[];
    let vidPaths: string[];
    let audPaths: string[];
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
      setCompactError(e.message);
      return;
    }

    const effectiveDuration = overrideConfig?.duration ?? duration;
    const effectiveResolution = overrideConfig
      ? overrideConfig.videoResolution
      : (effectiveCaps.resolutions.length > 0 ? videoResolution : undefined);
    const effectiveRatio = overrideConfig?.ratio ?? videoRatio;
    const effectiveQuality = overrideConfig
      ? overrideConfig.videoQuality
      : (effectiveCaps.qualities ? videoQuality : undefined);
    const effectiveCount = clampImageCount(overrideConfig?.n ?? videoCount);
    const effectiveFrameMode = overrideConfig
      ? overrideConfig.frameMode
      : (videoMode === 'firstlast'
          ? (firstFrame && lastFrame ? 'firstlast'
            : firstFrame ? 'first'
            : lastFrame ? 'last'
            : undefined)
          : undefined);
    const effectiveGenerateAudio = overrideConfig ? !!overrideConfig.generateAudio : generateAudio;

    const videoParams: JobParams = {
      ...(effectiveCaps.durations.length > 0 ? { duration: effectiveDuration } : {}),
      ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
      ...(effectiveCaps.ratios.length > 0 ? { ratio: effectiveRatio } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { mode: effectiveQuality } : {}),
      ...(effectiveFrameMode ? { frame_mode: effectiveFrameMode } : {}),
      ...(effectiveCaps.supportsAudio ? { generate_audio: effectiveGenerateAudio } : {}),
      ...(imgPaths.length ? { reference_images: imgPaths } : {}),
      ...(vidPaths.length ? { reference_videos: vidPaths } : {}),
      ...(audPaths.length ? { reference_audios: audPaths } : {}),
    };
    const estimatedCost = estimateGenerationCostForSubmission(
      selectedKey,
      effectiveModel,
      'video',
      videoParams,
    );
    if (estimatedCost != null) videoParams.estimated_cost_cny = estimatedCost;

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
      setCompactError(e.message);
    } finally {
      setPending(false);
    }
  };

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

function clampImageCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? 1), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(4, Math.max(1, Math.floor(parsed)));
}
