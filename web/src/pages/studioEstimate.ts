import type { KeyView } from '@/api/keys';
import { MAX_REF_IMAGES } from '@/components/studio/VideoReferenceAssets';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { MJ_IMAGES_PER_TASK, type ImageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { imageSizeMode } from '@/lib/imageSizeMode';
import { maxReferenceImages } from '@/lib/referenceLimits';
import type { VideoControlCaps, VideoMode, VideoQuality } from '@/lib/videoControlCaps';
import type { JobParams } from '@/schema/jobs';
import { clampImageCount } from './studioJobConfig';

/** 估价文案：「约 ¥1.40」。 */
export function costLabel(amount: number): string {
  return amount > 0 && amount < 0.01 ? '约 ¥<0.01' : `约 ¥${amount.toFixed(2)}`;
}

/** 本次提交真正会发出的参考图张数上限；null = 这一栏不按通用参考图计（Agent、MJ、首尾帧）。
 *  切模型不截参考：超出的留在输入里置灰，提交时只取前 N 张。 */
export function referenceImageLimit({ agent, kind, videoMode, imageCaps, videoCaps, model }: {
  agent: boolean;
  kind: 'image' | 'video';
  videoMode: VideoMode;
  imageCaps: ImageControlCaps;
  videoCaps: VideoControlCaps;
  model: string;
}): number | null {
  if (agent) return null;
  if (kind === 'video') return videoMode === 'omni' ? videoCaps.maxRefImages ?? MAX_REF_IMAGES : null;
  return imageCaps.family === 'midjourney' ? null : imageCaps.maxRefImages ?? maxReferenceImages(model);
}

/** 提交按钮旁常显的估价（D7）：「4 张 · 约 ¥1.40」；未计价、自动尺寸时返回 null。 */
export function studioEstimateLabel(input: {
  key: KeyView | undefined;
  modelId: string;
  kind: 'image' | 'video';
  imageCaps: ImageControlCaps;
  sizeParams: JobParams;
  count: number;
  quality: Quality;
  referenceImages: number;
  videoCaps: VideoControlCaps;
  videoCount: number;
  duration: number;
  videoResolution: string;
  videoRatio: string;
  videoQuality: VideoQuality;
  generateAudio: boolean;
  referenceVideos: number;
}): string | null {
  const { key, modelId, imageCaps, videoCaps } = input;
  if (!key || !modelId) return null;
  if (input.kind === 'video') {
    const n = clampImageCount(input.videoCount);
    const cost = estimateGenerationCostForSubmission(key, modelId, 'video', {
      ...(videoCaps.durations.length > 0 ? { duration: input.duration } : {}),
      ...(videoCaps.resolutions.length > 0 ? { resolution: input.videoResolution } : {}),
      ...(videoCaps.ratios.length > 0 ? { ratio: input.videoRatio } : {}),
      n,
      ...(videoCaps.qualities ? { mode: input.videoQuality } : {}),
      ...(videoCaps.supportsAudio ? { generate_audio: input.generateAudio } : {}),
      ...(input.referenceVideos ? { reference_videos: Array(input.referenceVideos).fill('reference') } : {}),
    });
    return cost != null ? `${n} 条 · ${costLabel(cost)}` : null;
  }
  if (imageSizeMode(input.sizeParams) === 'auto') return null;
  const n = imageCaps.family === 'midjourney'
    ? MJ_IMAGES_PER_TASK
    : Math.min(imageCaps.maxCount ?? 4, clampImageCount(input.count));
  const cost = estimateGenerationCostForSubmission(key, modelId, 'image', {
    ...input.sizeParams,
    n,
    quality: imageCaps.qualities?.includes(input.quality) ? input.quality : undefined,
    ...(input.referenceImages ? { reference_images: Array(input.referenceImages).fill('reference') } : {}),
  });
  return cost != null ? `${n} 张 · ${costLabel(cost)}` : null;
}
