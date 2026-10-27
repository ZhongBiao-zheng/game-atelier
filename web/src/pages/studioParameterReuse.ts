import { modelModality, type KeyView } from '@/api/keys';
import type { RoundConfig } from '@/components/studio/RoundList';
import type { JobKind, JobParams } from '@/schema/jobs';
import { normalizeImageSizeParams } from '@/lib/imageSizeMode';
import { providerForAlias, sizeContext, resolveChannel } from '@/lib/modelRoutes';
import { videoControlCaps } from '@/lib/videoControlCaps';
import { clampImageCount } from './studioJobConfig';

export type RoundParameter = 'model' | 'size' | 'resolution' | 'quality' | 'count' | 'duration' | 'audio';
export interface ParameterReuseContext {
  providers: KeyView[];
  alias: string;
  model: string;
  kind: JobKind;
  sizeParams: JobParams;
}
export interface ParameterPatch {
  alias?: string;
  model?: string;
  kind?: 'image' | 'video';
  sizeParams?: JobParams;
  quality?: RoundConfig['quality'];
  count?: number;
  videoRatio?: string;
  videoResolution?: string;
  videoQuality?: RoundConfig['videoQuality'];
  videoCount?: number;
  duration?: number;
  generateAudio?: boolean;
}

/** A null patch is also the disabled-state predicate, so rendering and applying use identical caps. */
export function reuseRoundParameter(config: RoundConfig, parameter: RoundParameter, context: ParameterReuseContext): ParameterPatch | null {
  const { providers, alias, model, kind, sizeParams } = context;
  if (parameter === 'model') {
    const key = providerForAlias(providers, config.alias);
    const selected = key?.models.find(item => item.id === config.model);
    if (!key || key.enabled === false || !selected) return null;
    const modality = modelModality(selected, key);
    if (modality !== 'image' && modality !== 'video') return null;
    return { alias: key.alias, model: selected.id, kind: modality };
  }
  if ((config.kind ?? 'image') !== kind || !model) return null;
  const key = providerForAlias(providers, alias);
  if (!key || key.enabled === false || !key.models.some(item => item.id === model)) return null;
  if (kind === 'video') {
    const channel = resolveChannel(providers, key, model);
    const selected = channel.key?.models.find(item => item.id === channel.modelId);
    const caps = videoControlCaps(channel.modelId, selected?.protocol);
    switch (parameter) {
      case 'size': return config.ratio && caps.ratios.includes(config.ratio) ? { videoRatio: config.ratio } : null;
      case 'resolution': return config.videoResolution && caps.resolutions.includes(config.videoResolution) ? { videoResolution: config.videoResolution } : null;
      case 'quality': return config.videoQuality && caps.qualities?.includes(config.videoQuality) ? { videoQuality: config.videoQuality } : null;
      case 'duration': return config.duration != null && caps.durations.includes(config.duration) ? { duration: config.duration } : null;
      case 'audio': return config.generateAudio != null && caps.supportsAudio ? { generateAudio: config.generateAudio } : null;
      case 'count': return config.n != null ? { videoCount: clampImageCount(config.n) } : null;
    }
  }
  if (kind !== 'image') return null;
  const size = sizeContext(providers, key, model);
  const caps = size.caps;
  switch (parameter) {
    case 'size': {
      const mode = config.sizeMode ?? (config.size === 'auto' ? 'auto' : config.ratio ? 'ratio' : 'custom');
      if (mode === 'auto' && !caps.showAutoSize || mode === 'custom' && (!caps.showCustomSize || !config.size)
        || mode === 'ratio' && !caps.ratios.includes(config.ratio ?? '')) return null;
      const patch = mode === 'ratio' ? { size_mode: mode, ratio: config.ratio, size: undefined }
        : { size_mode: mode, size: mode === 'auto' ? 'auto' : config.size };
      return { sizeParams: normalizeImageSizeParams(size.modelId, size.provider, size.baseUrl, { ...sizeParams, ...patch }, caps) };
    }
    case 'resolution': return config.resolution && caps.resolutions.includes(config.resolution)
      ? { sizeParams: normalizeImageSizeParams(size.modelId, size.provider, size.baseUrl, { ...sizeParams, resolution: config.resolution, ...(sizeParams.size_mode === 'custom' ? {} : { size: undefined }) }, caps) } : null;
    case 'quality': return config.quality && caps.qualities?.includes(config.quality) ? { quality: config.quality } : null;
    case 'count': return config.n != null && caps.family !== 'midjourney' ? { count: Math.min(caps.maxCount ?? 4, clampImageCount(config.n)) } : null;
    default: return null;
  }
}
