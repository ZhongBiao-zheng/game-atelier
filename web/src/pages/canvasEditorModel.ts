import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import {
  normalizeStudioSizeForModel,
  studioSizeFor,
  type Resolution,
} from '@/lib/studioSize';
import type { JobParams } from '@/schema/jobs';
import {
  videoControlCaps,
  type VideoControlCaps,
  type VideoQuality,
} from '@/lib/videoControlCaps';

export function normalizeCanvasImageParams(
  model: string,
  provider: string | null | undefined,
  current: JobParams,
): JobParams {
  const caps = imageControlCaps(model, provider);
  const {
    quality: currentQuality,
    reference_images: _referenceImages,
    reference_videos: _referenceVideos,
    reference_audios: _referenceAudios,
    resolution: _resolution,
    size: _size,
    ...retained
  } = current;
  const currentRatio = String(current.ratio ?? '');
  const ratio = caps.ratios.includes(currentRatio) ? currentRatio : caps.ratios[0];
  const n = caps.family === 'midjourney'
    ? MJ_IMAGES_PER_TASK
    : 1;
  const params: JobParams = { ...retained, n, ratio };

  if (caps.showResolution && caps.resolutions.length) {
    params.resolution = caps.resolutions.includes(current.resolution as Resolution)
      ? current.resolution
      : caps.resolutions[0];
  }
  if (caps.qualities?.length) {
    params.quality = caps.qualities.includes(currentQuality as Quality)
      ? currentQuality
      : caps.qualities[0];
  }
  if (caps.sizeKind === 'ratio') {
    params.size = ratio;
  } else if (caps.sizeKind === 'pixels') {
    const resolution = (params.resolution as Resolution | undefined) ?? '2K';
    params.size = normalizeStudioSizeForModel(studioSizeFor(ratio, resolution, model), model);
  }
  return params;
}

export function canvasVideoEditCaps(
  model: string,
  protocol: string | null | undefined,
): VideoControlCaps {
  return videoControlCaps(model, protocol);
}

export function supportsCanvasVideoEdit(
  model: string,
  protocol: string | null | undefined,
): boolean {
  const caps = canvasVideoEditCaps(model, protocol);
  // Canvas Content Version 永远是服务端本地文件；HappyHorse video-edit 只收公网 URL，
  // 不能把“协议支持”冒充成“当前空间可执行”。Seedance 会走项目已有 OSS 中转。
  return caps.supportsReferenceVideo && caps.family !== 'happyhorse';
}

export function normalizeCanvasVideoParams(
  model: string,
  protocol: string | null | undefined,
  current: JobParams,
  editingExistingVideo = false,
): JobParams {
  const caps = canvasVideoEditCaps(model, protocol);
  const {
    duration: currentDuration,
    resolution: currentResolution,
    ratio: currentRatio,
    mode: currentQuality,
    frame_mode: currentFrameMode,
    generate_audio: currentGenerateAudio,
    reference_images: _referenceImages,
    reference_videos: _referenceVideos,
    reference_audios: _referenceAudios,
    n: _count,
    size: _size,
    quality: _imageQuality,
    mask_image: _mask,
    angle_horizontal: _angleHorizontal,
    angle_pitch: _anglePitch,
    angle_distance: _angleDistance,
    angle_wide: _angleWide,
    voice: _voice,
    speed: _speed,
    response_format: _responseFormat,
    instructions: _instructions,
    temperature: _temperature,
    max_tokens: _maxTokens,
    ...retained
  } = current;
  const params: JobParams = { ...retained };

  if (caps.durations.length) {
    const duration = Number(currentDuration);
    params.duration = caps.durations.includes(duration)
      ? duration
      : caps.durations.includes(5) ? 5 : caps.durations[0];
  }
  if (caps.resolutions.length) {
    params.resolution = caps.resolutions.includes(String(currentResolution))
      ? String(currentResolution)
      : caps.resolutions[0];
  }
  if (caps.ratios.length) {
    params.ratio = caps.ratios.includes(String(currentRatio))
      ? String(currentRatio)
      : caps.ratios.includes('16:9') ? '16:9' : caps.ratios[0];
  }
  if (caps.qualities?.length) {
    params.mode = caps.qualities.includes(currentQuality as VideoQuality)
      ? currentQuality
      : caps.qualities[0];
  }
  if (caps.supportsAudio) {
    params.generate_audio = typeof currentGenerateAudio === 'boolean'
      ? currentGenerateAudio
      : true;
  }
  if (editingExistingVideo) {
    params.frame_mode = 'auto';
  } else if (currentFrameMode) {
    params.frame_mode = currentFrameMode;
  }
  return params;
}
