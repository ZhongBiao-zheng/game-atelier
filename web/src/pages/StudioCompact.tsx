import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';

import { createStudioJob, resolveImageReferencePaths, uploadReferenceImage } from '@/api/studio';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { PromptInput } from '@/components/studio/PromptInput';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import type { RoundConfig } from '@/components/studio/RoundList';
import { imageSizeError, imageSizeMode, normalizeImageSizeParams } from '@/lib/imageSizeMode';
import { normalizeImagePixelSize } from '@/lib/studioSize';
import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import { hasSrefCode, MJ_DEFAULTS, mjParamsToJob, type MjParams } from '@/lib/mjParams';
import { EMPTY_MJ_REFS, type MjRefSlots } from '@/components/studio/MjReferenceSlots';
import { videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import type { JobKind, JobParams } from '@/schema/jobs';
import { readStudioDraft, writeStudioDraft } from './studioDraft';

const SELECTION_STORAGE_KEY = 'studio:selection';

interface SavedSelection {
  providerAlias?: string;
  model?: string;
  sizeParams?: JobParams;
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
    // localStorage 不可用时不影响首页输入。
  }
}

export function StudioCompact() {
  const [, setLocation] = useLocation();
  const [saved] = useState(loadSelection);
  const [draft] = useState(readStudioDraft);
  const [pending, setPending] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  const [sizeParams, setSizeParams] = useState<JobParams>(draft?.sizeParams ?? saved.sizeParams ?? { size_mode: 'ratio', ratio: '1:1', resolution: '2K' });
  const [count, setCount] = useState(draft?.count ?? 1);
  const [quality, setQuality] = useState<Quality>(draft?.quality ?? 'low');
  // 与 StudioFull 同一政策：MJ 参数不进 localStorage，每次启动回默认。
  const [mjParams, setMjParams] = useState<MjParams>(draft?.mjParams ?? MJ_DEFAULTS);
  const [mjRefs, setMjRefs] = useState<MjRefSlots>(draft?.mjRefs ?? EMPTY_MJ_REFS);
  const [promptText, setPromptText] = useState(draft?.promptText ?? '');
  const [referenceImages, setReferenceImages] = useState<File[]>(draft?.referenceImages ?? []);
  const [kind, setKind] = useState<JobKind>(draft?.kind ?? saved.kind ?? 'image');
  const [videoMode, setVideoMode] = useState<VideoMode>(draft?.videoMode ?? (saved.videoMode === 'omni' ? 'omni' : 'firstlast'));
  const [duration, setDuration] = useState<number>(draft?.duration ?? saved.duration ?? 5);
  const [videoResolution, setVideoResolution] = useState<string>(draft?.videoResolution ?? saved.videoResolution ?? '720p');
  const [videoRatio, setVideoRatio] = useState<string>(draft?.videoRatio ?? saved.videoRatio ?? '16:9');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(draft?.videoQuality ?? (saved.videoQuality === 'pro' ? 'pro' : 'std'));
  const [videoCount, setVideoCount] = useState<number>(draft?.videoCount ?? clampImageCount(saved.videoCount ?? 1));
  const [generateAudio, setGenerateAudio] = useState<boolean>(draft?.generateAudio ?? saved.generateAudio ?? false);
  const [referenceVideos, setReferenceVideos] = useState<File[]>(draft?.referenceVideos ?? []);
  const [referenceAudios, setReferenceAudios] = useState<File[]>(draft?.referenceAudios ?? []);
  const [videoFrames, setVideoFrames] = useState<FrameSlots>(draft?.videoFrames ?? { first: null, last: null });

  // 每次改动都把未提交的输入写进内存草稿；切页卸载后回来按它恢复，刷新即清空。
  useEffect(() => {
    writeStudioDraft({
      providerAlias, model, kind, promptText, promptAssetSourceTitle: null,
      referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs, mjParams,
      sizeParams, count, quality,
      videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, kind, promptText,
    referenceImages, referenceVideos, referenceAudios, videoFrames, mjRefs, mjParams,
    sizeParams, count, quality,
    videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);
  const selectedModelObj = keys.find((k) => k.alias === providerAlias)?.models.find((m) => m.id === model);
  const videoCaps = videoControlCaps(model, selectedModelObj?.protocol);

  useEffect(() => {
    let cancelled = false;
    listKeys()
      .then((resp) => {
        if (cancelled) return;
        const usable = resp.keys.filter((key) => key.models.length > 0);
        setKeys(usable);
        const wantedAlias = draft?.providerAlias || saved.providerAlias;
        const wantedModel = draft?.model || saved.model;
        const savedKey = wantedAlias
          ? usable.find((key) => key.alias === wantedAlias)
          : undefined;
        const selected = savedKey ?? usable[0];
        setProviderAlias(selected?.alias ?? '');
        const savedModelValid = wantedModel && selected?.models.some((m) => m.id === wantedModel);
        const nextModel = savedModelValid ? wantedModel! : selected?.models[0]?.id ?? '';
        setModel(nextModel);
      })
      .catch(() => {
        if (!cancelled) setKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [saved, draft]);

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
      providerAlias, model, sizeParams, quality,
      kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, sizeParams, quality,
    kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);

  const handleSizeParamsChange = useCallback((patch: JobParams) => {
    setSizeParams(previous => {
      const selected = keys.find(key => key.alias === providerAlias);
      return normalizeImageSizeParams(model, selected?.provider, selected?.base_url, { ...previous, ...patch });
    });
  }, [keys, providerAlias, model]);

  const onSubmit = async (prompt: string, overrideConfig?: RoundConfig) => {
    const wantVideo = overrideConfig ? overrideConfig.kind === 'video' : kind === 'video';
    if (wantVideo) {
      await onSubmitVideo(prompt, overrideConfig);
      return;
    }
    const effectiveAlias = overrideConfig?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? model;
    const selectedKey = keys.find((item) => item.alias === effectiveAlias);
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    // 与 Studio.onSubmit 同一套判据：能力按模型族，provider 只在 openrouter 上改 size 语义。
    const caps = imageControlCaps(
      effectiveModel,
      effectiveProvider,
      selectedKey?.base_url,
    );
    // MJ 一次 imagine 固定回 4 张方案（同 Studio.onSubmit）。
    const effectiveCount = caps.family === 'midjourney'
      ? MJ_IMAGES_PER_TASK
      : clampImageCount(overrideConfig?.n ?? count);
    const rawSizeParams: JobParams = overrideConfig
      ? { size_mode: overrideConfig.sizeMode ?? 'ratio', size: overrideConfig.size, ratio: overrideConfig.ratio, resolution: overrideConfig.resolution }
      : sizeParams;
    if (imageSizeError(rawSizeParams, effectiveModel)) return;
    const effectiveSizeParams = normalizeImageSizeParams(effectiveModel, effectiveProvider, selectedKey?.base_url, rawSizeParams);
    const effectiveMode = imageSizeMode(effectiveSizeParams);
    if (effectiveMode !== imageSizeMode(rawSizeParams)) {
      setCompactError('当前模型不支持原尺寸模式，请重新选择');
      return;
    }
    if (effectiveMode === 'custom' && effectiveSizeParams.size) {
      effectiveSizeParams.size = normalizeImagePixelSize(effectiveSizeParams.size, effectiveModel, selectedKey?.base_url);
      if (!overrideConfig) setSizeParams(previous => ({ ...previous, size: effectiveSizeParams.size, custom_size: effectiveSizeParams.size }));
    }
    const effectiveSize = effectiveSizeParams.size;
    const effectiveRatio = effectiveMode === 'ratio' ? effectiveSizeParams.ratio : undefined;
    const effectiveResolution = effectiveMode === 'ratio' ? effectiveSizeParams.resolution as '2K' | '4K' | undefined : undefined;
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
      size_mode: effectiveMode,
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(effectiveRatio ? { ratio: effectiveRatio } : {}),
      ...(effectiveResolution ? { resolution: effectiveResolution } : {}),
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
    if (estimatedCost != null && effectiveMode !== 'auto') jobParams.estimated_cost_cny = estimatedCost;

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
          setSizeParams(previous => imageSizeMode(previous) === 'ratio' ? { ...previous, size: undefined } : previous);
        }}
        onCountChange={setCount}
        onQualityChange={setQuality}
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
