import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'wouter';

import { createStudioJob, getStudioJob, listStudioJobs, uploadReferenceImage } from '@/api/studio';
import { listKeys, type KeyView } from '@/api/keys';
import { PromptInput } from '@/components/studio/PromptInput';
import { RoundList, type RoundConfig, type RoundState } from '@/components/studio/RoundList';
import { studioSizeFor, computeStudioPixelSize, normalizeStudioSizeForModel } from '@/lib/studioSize';
import { imageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { videoControlCaps, type VideoFrameMode, type VideoMode } from '@/lib/videoControlCaps';
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
  frameMode?: VideoFrameMode;
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
  const [persistedJobs, setPersistedJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState(false);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [providerAlias, setProviderAlias] = useState('');
  const [model, setModel] = useState('');
  const [ratio, setRatio] = useState(saved.ratio ?? '1:1');
  const [resolution, setResolution] = useState<'2K' | '4K'>(saved.resolution ?? '2K');
  const [count, setCount] = useState(clampImageCount(saved.count ?? 1));
  const [customSize, setCustomSize] = useState(saved.customSize ?? '');
  const [quality, setQuality] = useState<Quality>(saved.quality ?? 'medium');
  const [sizeOverride, setSizeOverride] = useState<{ key: number; w: number; h: number } | undefined>(undefined);
  const [promptText, setPromptText] = useState('');
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [kind, setKind] = useState<JobKind>(saved.kind ?? 'image');
  const [videoMode, setVideoMode] = useState<VideoMode>(saved.videoMode ?? 'i2v');
  const [duration, setDuration] = useState<number>(saved.duration ?? 5);
  const [videoResolution, setVideoResolution] = useState<string>(saved.videoResolution ?? '720p');
  const [videoRatio, setVideoRatio] = useState<string>(saved.videoRatio ?? '16:9');
  const [frameMode, setFrameMode] = useState<VideoFrameMode>(saved.frameMode ?? 'auto');
  const [generateAudio, setGenerateAudio] = useState<boolean>(saved.generateAudio ?? false);
  const [referenceVideos, setReferenceVideos] = useState<File[]>([]);
  const [referenceAudios, setReferenceAudios] = useState<File[]>([]);
  const videoCaps = videoControlCaps(model);
  // 切到视频模式时，若当前 key 不支持 video，自动选中首个 video 能力的 key —— 让 videoCaps 立即正确（否则退化成 STANDARD_CAPS）。
  useEffect(() => {
    if (kind !== 'video' || keys.length === 0) return;
    const cur = keys.find((k) => k.alias === providerAlias);
    if (cur?.modalities?.includes('video')) return;
    const v = keys.find((k) => k.modalities?.includes('video'));
    if (v) {
      setProviderAlias(v.alias);
      setModel(v.models[0]?.id ?? '');
    }
    // 仅在切到视频模式 / keys 加载时触发；providerAlias 不入依赖，避免用户改回非视频 key 时被反复抢选成死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, keys]);
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
    setReferenceImages(files);
  }, []);

  const refreshPersistedJobs = useCallback(async () => {
    const jobs = await listStudioJobs();
    setPersistedJobs(jobs);
    return jobs;
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
        // 优先恢复上次保存的供应商/模型（校验仍存在），否则回落到默认 key。
        const savedKey = saved.providerAlias
          ? usable.find((key) => key.alias === saved.providerAlias)
          : undefined;
        const selected = savedKey ?? usable.find((key) => key.alias === resp.default_alias) ?? usable[0];
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
      kind, videoMode, duration, videoResolution, videoRatio, frameMode, generateAudio,
    });
  }, [
    providerAlias, model, ratio, resolution, count, quality, customSize,
    kind, videoMode, duration, videoResolution, videoRatio, frameMode, generateAudio,
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

  const hasActivePersistedJob = persistedJobs.some(
    (job) => job.status === 'pending' || job.status === 'pending_confirm',
  );

  useEffect(() => {
    if (compact || !hasActivePersistedJob) return;
    const id = window.setInterval(() => {
      void refreshPersistedJobs();
    }, 2000);
    return () => window.clearInterval(id);
  }, [compact, hasActivePersistedJob, refreshPersistedJobs]);

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
      if (!compact) {
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
      } finally {
        setPending(false);
      }
      return;
    }

    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, config };
    setRounds((rs) => [myRound, ...rs]);

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
    setRounds((rs) =>
      rs.map((r) =>
        r === myRound
          ? { ...myRound, jobId: job.job_id, startedAt: Date.parse(job.submitted_at) || startedAt }
          : r,
      ),
    );

    void pollJobUntilTerminal(job.job_id, (final) => {
      setPersistedJobs((items) => upsertJob(items, final));
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound
            ? final.status === 'done' && final.output_paths.length > 0
              ? { kind: 'done', jobId: final.job_id, submittedAt: final.submitted_at, imagePaths: final.output_paths, config }
              : { kind: 'failed', jobId: final.job_id, submittedAt: final.submitted_at, reason: final.error ?? '生成完成但未返回图片', config }
            : r,
        ),
      );
    }).catch((e: any) => {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message, config } : r,
        ),
      );
    });
  };

  const onSubmitVideo = async (prompt: string, overrideConfig?: RoundConfig) => {
    // 切到视频后 PromptInput 只是按 modalities 过滤显示，父级 providerAlias/model 不一定已是视频 key——这里收敛。
    const videoKeys = keys.filter((item) => item.modalities?.includes('video'));
    const selectedKey =
      (overrideConfig?.alias ? keys.find((item) => item.alias === overrideConfig.alias) : undefined)
      ?? videoKeys.find((item) => item.alias === providerAlias)
      ?? videoKeys[0];
    const effectiveAlias = overrideConfig?.alias ?? selectedKey?.alias ?? providerAlias;
    const effectiveModel = overrideConfig?.model ?? selectedKey?.models[0]?.id ?? model;
    const effectiveProvider = selectedKey?.provider ?? overrideConfig?.provider;
    const selectedModel = selectedKey?.models.find((item) => item.id === effectiveModel);

    setPending(true);
    // 视频/音频参考图复用通用文件上传端点（Task 1 已放开 video/audio）。override 携带的已是服务器路径，直接复用。
    let imgPaths: string[];
    let vidPaths: string[];
    let audPaths: string[];
    try {
      imgPaths = overrideConfig?.referenceImages
        ?? (referenceImages.length > 0 ? await Promise.all(referenceImages.map(uploadReferenceImage)) : []);
      vidPaths = overrideConfig ? [] : (referenceVideos.length > 0 ? await Promise.all(referenceVideos.map(uploadReferenceImage)) : []);
      audPaths = overrideConfig ? [] : (referenceAudios.length > 0 ? await Promise.all(referenceAudios.map(uploadReferenceImage)) : []);
    } catch (e: any) {
      setPending(false);
      if (!compact) {
        setRounds((rs) => [
          { kind: 'failed', submittedAt: new Date().toISOString(), reason: `参考资产上传失败：${e.message}` },
          ...rs,
        ]);
      }
      return;
    }

    const videoParams: JobParams = {
      duration: overrideConfig?.n ?? duration,
      resolution: overrideConfig?.resolution ?? videoResolution,
      ratio: overrideConfig?.ratio ?? videoRatio,
      frame_mode: frameMode,
      ...(generateAudio ? { generate_audio: true } : {}),
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
      ratio: overrideConfig?.ratio ?? videoRatio,
      referenceImages: imgPaths,
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
      } finally {
        setPending(false);
      }
      return;
    }

    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, config };
    setRounds((rs) => [myRound, ...rs]);

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
    setRounds((rs) =>
      rs.map((r) =>
        r === myRound
          ? { ...myRound, jobId: job.job_id, startedAt: Date.parse(job.submitted_at) || startedAt }
          : r,
      ),
    );

    void pollJobUntilTerminal(job.job_id, (final) => {
      setPersistedJobs((items) => upsertJob(items, final));
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound
            ? final.status === 'done' && final.output_paths.length > 0
              ? { kind: 'done', jobId: final.job_id, submittedAt: final.submitted_at, imagePaths: final.output_paths, config }
              : { kind: 'failed', jobId: final.job_id, submittedAt: final.submitted_at, reason: final.error ?? '生成完成但未返回视频', config }
            : r,
        ),
      );
    }).catch((e: any) => {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message, config } : r,
        ),
      );
    });
  };

  if (compact) {
    return (
      <div className="py-8" aria-label="生图沙箱">
        <h1 className="text-xl sm:text-2xl leading-tight mb-6 sm:mb-8 max-w-[780px] mx-auto font-semibold">
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
          frameMode={frameMode}
          generateAudio={generateAudio}
          onVideoModeChange={setVideoMode}
          onDurationChange={setDuration}
          onVideoResolutionChange={setVideoResolution}
          onVideoRatioChange={setVideoRatio}
          onFrameModeChange={setFrameMode}
          onGenerateAudioChange={setGenerateAudio}
          referenceVideos={referenceVideos}
          referenceAudios={referenceAudios}
          onReferenceVideosChange={setReferenceVideos}
          onReferenceAudiosChange={setReferenceAudios}
        />
      </div>
    );
  }

  return (
    <div
      className="h-[calc(100vh-56px)] md:h-[calc(100vh-80px)] flex flex-col overflow-hidden px-3 sm:px-6"
      aria-label="生图沙箱"
    >
      <div className="flex-1 min-h-0 overflow-y-auto py-6">
        <RoundList
          rounds={rounds}
          onDeleteFailed={deleteFailedRound}
          onReEdit={reEdit}
          onRegenerate={regenerate}
          onDeleteBatch={deleteDoneBatch}
          onReuseReferences={handleReuseReferences}
        />
      </div>
      <div className="shrink-0 py-4 border-t border-border/30">
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
          frameMode={frameMode}
          generateAudio={generateAudio}
          onVideoModeChange={setVideoMode}
          onDurationChange={setDuration}
          onVideoResolutionChange={setVideoResolution}
          onVideoRatioChange={setVideoRatio}
          onFrameModeChange={setFrameMode}
          onGenerateAudioChange={setGenerateAudio}
          referenceVideos={referenceVideos}
          referenceAudios={referenceAudios}
          onReferenceVideosChange={setReferenceVideos}
          onReferenceAudiosChange={setReferenceAudios}
        />
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
    if (config.ratio) setRatio(config.ratio);
    if (config.resolution) setResolution(config.resolution);
    if (config.n) setCount(clampImageCount(config.n));
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
  return Array.from(new Set(refs));
}

function configForJob(job: Job, keys: KeyView[] = []): RoundConfig {
  const selectedKey = keys.find((item) => item.alias === job.alias);
  const selectedModel = selectedKey?.models.find((item) => item.id === job.model);
  return {
    prompt: job.prompt,
    kind: job.kind === 'video' ? 'video' : 'image',
    alias: job.alias,
    provider: job.provider,
    model: job.model,
    modelName: selectedModel?.name,
    ratio: typeof job.params.ratio === 'string' ? job.params.ratio : undefined,
    resolution: job.params.resolution === '4K' ? '4K' : job.params.resolution === '2K' ? '2K' : undefined,
    size: typeof job.params.size === 'string' ? job.params.size : undefined,
    n: typeof job.params.n === 'number' ? clampImageCount(job.params.n) : undefined,
    quality: (job.params.quality === 'low' || job.params.quality === 'medium'
      || job.params.quality === 'high' || job.params.quality === 'auto')
      ? job.params.quality
      : undefined,
    referenceImages: referenceImagesFor(job),
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
    .filter((job) => job.namespace === 'studio')
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))
    .flatMap((job): RoundState[] => {
      if (job.status === 'done') {
        if (job.output_paths.length === 0) return [];
        return [{
          kind: 'done' as const,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          imagePaths: job.output_paths,
          config: configForJob(job, keys),
        }];
      }
      if (job.status === 'failed') {
        return [{
          kind: 'failed' as const,
          jobId: job.job_id,
          submittedAt: job.submitted_at,
          reason: job.error ?? '生成失败',
          config: configForJob(job, keys),
        }];
      }
      return [{
        kind: 'pending' as const,
        jobId: job.job_id,
        startedAt: Date.parse(job.submitted_at) || Date.now(),
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

export async function pollJobUntilTerminal(
  jobId: string,
  onFinal: (job: Job) => void,
) {
  // 媒体类型决定轮询上限：图片 120×2s≈4min；视频跑分钟级 → 220×5s≈18min。
  // kind 从首次成功拉取的 job 读出（不依赖调用点透传）。
  let intervalMs = 2000;
  let maxPolls = 120;
  let kind: Job['kind'] = 'image';
  let polls = 0;
  while (polls < maxPolls) {
    await new Promise((r) => setTimeout(r, intervalMs));
    polls += 1;
    const job = await getStudioJob(jobId);
    if (!job) continue;
    if (job.kind === 'video' && kind !== 'video') {
      kind = 'video';
      intervalMs = 5000;
      maxPolls = 220;
    }
    if (job.status === 'done' || job.status === 'failed') {
      onFinal(job);
      return;
    }
  }
  onFinal({
    job_id: jobId,
    character_id: '',
    prompt: '',
    submitted_at: new Date().toISOString(),
    model: '',
    params: {},
    seed: null,
    output_paths: [],
    status: 'failed',
    error: 'timeout',
    kind,
    namespace: 'studio',
  });
}

function upsertJob(items: Job[], next: Job): Job[] {
  const without = items.filter((item) => item.job_id !== next.job_id);
  return [next, ...without];
}
