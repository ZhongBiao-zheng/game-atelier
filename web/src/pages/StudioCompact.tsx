import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';

import { createStudioJob, uploadReferenceImage } from '@/api/studio';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { PromptInput } from '@/components/studio/PromptInput';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import type { RoundConfig } from '@/components/studio/RoundList';
import { computeStudioPixelSize, normalizeStudioSizeForModel, studioSizeFor } from '@/lib/studioSize';
import { imageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { videoControlCaps, type VideoMode, type VideoQuality } from '@/lib/videoControlCaps';
import type { JobKind, JobParams } from '@/schema/jobs';

const SELECTION_STORAGE_KEY = 'studio:selection';

interface SavedSelection {
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
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
  const [quality, setQuality] = useState<Quality>('low');
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
        if (saved.customSize) {
          const [wStr, hStr] = saved.customSize.split('x');
          const w = parseInt(wStr, 10);
          const h = parseInt(hStr, 10);
          if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
            const standard = computeStudioPixelSize(saved.ratio ?? '1:1', saved.resolution ?? '2K', nextModel);
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
      providerAlias, model, ratio, resolution, quality, customSize,
      kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
    });
  }, [
    providerAlias, model, ratio, resolution, quality, customSize,
    kind, videoMode, duration, videoResolution, videoRatio, videoQuality, videoCount, generateAudio,
  ]);

  const handleCustomSizeChange = useCallback((w: number, h: number) => {
    setCustomSize(`${w}x${h}`);
  }, []);

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
    // 与 Studio.onSubmit 同一套判据：能力按模型族，provider 只在 openrouter 上改 size 语义。
    const caps = imageControlCaps(effectiveModel, effectiveProvider);
    const effectiveSize = overrideConfig?.size
      ?? (caps.sizeKind === 'ratio'
        ? effectiveRatio
        : normalizeStudioSizeForModel(
            customSize || studioSizeFor(effectiveRatio, effectiveResolution, effectiveModel),
            effectiveModel,
          ));
    const rawQuality = overrideConfig?.quality ?? quality;
    const effectiveQuality = caps.qualities?.includes(rawQuality) ? rawQuality : undefined;

    setPending(true);
    setCompactError(null);
    let refPaths: string[];
    try {
      refPaths = overrideConfig?.referenceImages
        ?? (referenceImages.length > 0
          ? await Promise.all(referenceImages.map(uploadReferenceImage))
          : []);
    } catch (e: any) {
      setPending(false);
      setCompactError(`参考图上传失败：${e.message}`);
      return;
    }

    // 控件隐藏的参数不写进 params（同 Studio.onSubmit）：openrouter 会把 resolution 当 API 参数发。
    const jobParams: JobParams = {
      size: effectiveSize,
      ...(caps.ratios.length > 0 ? { ratio: effectiveRatio } : {}),
      ...(caps.showResolution ? { resolution: effectiveResolution } : {}),
      n: effectiveCount,
      ...(effectiveQuality ? { quality: effectiveQuality } : {}),
      ...(refPaths.length > 0 ? { reference_images: refPaths } : {}),
    };

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
      setCompactError(`参考资产上传失败：${e.message}`);
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
      setCompactError(`提交失败：${e.message}`);
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
