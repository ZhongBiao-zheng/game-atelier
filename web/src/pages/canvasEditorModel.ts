import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import {
  normalizeStudioSizeForModel,
  studioSizeFor,
  type Resolution,
} from '@/lib/studioSize';
import type { CanvasGenerationNode } from '@/schema/canvas';
import type { JobKind, JobParams } from '@/schema/jobs';

interface CanvasJobBody {
  prompt: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind: JobKind;
}

export function buildCanvasGenerationRequest(
  target: CanvasGenerationNode,
  provider?: string | null,
): CanvasJobBody {
  const params: JobParams = target.data.media_kind === 'image'
    ? normalizeCanvasImageParams(target.data.draft.model, provider, target.data.draft.params)
    : { ...target.data.draft.params };
  delete params.reference_images;
  delete params.reference_videos;
  delete params.reference_audios;

  return {
    prompt: target.data.draft.prompt.trim(),
    model: target.data.draft.model,
    params,
    alias: target.data.draft.alias || undefined,
    kind: target.data.media_kind,
  };
}

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
