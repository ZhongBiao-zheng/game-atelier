import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import {
  normalizeStudioSizeForModel,
  studioSizeFor,
  type Resolution,
} from '@/lib/studioSize';
import type { JobParams } from '@/schema/jobs';

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
