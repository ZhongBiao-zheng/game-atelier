import { MAX_MJ_REFS_PER_SLOT } from '@/components/studio/MjReferenceSlots';
import { MAX_REF_IMAGES } from '@/components/studio/VideoReferenceAssets';
import { imageFamily } from '@/lib/modelFamily';
import { maxReferenceImages } from '@/lib/referenceLimits';
import { videoReferenceLimits, type VideoControlCaps, type VideoMode } from '@/lib/videoControlCaps';
import type { JobKind } from '@/schema/jobs';

/** 媒体资产「使用」时要落的槽位：必须是当前模式下真正会被提交的那一个。 */
export type StudioMediaTarget = 'images' | 'mj' | 'frame' | 'videos' | 'audios';

export interface StudioMediaSlots {
  kind: JobKind;
  videoMode: VideoMode;
  model: string;
  videoCaps: VideoControlCaps | null;
  counts: { images: number; mj: number; videos: number; audios: number };
}

export type StudioMediaRoute = { target: StudioMediaTarget } | { notice: string };

function routeImage(slots: StudioMediaSlots): StudioMediaRoute {
  if (slots.kind === 'video') {
    if (slots.videoMode === 'firstlast') {
      return (slots.videoCaps?.maxFrames ?? 2) < 1 ? { notice: '当前模型不支持参考图' } : { target: 'frame' };
    }
    const limit = slots.videoCaps ? videoReferenceLimits(slots.videoCaps, 'omni').images : MAX_REF_IMAGES;
    return slots.counts.images < limit ? { target: 'images' } : { notice: '参考图已满' };
  }
  if (imageFamily(slots.model) === 'midjourney') {
    return slots.counts.mj < MAX_MJ_REFS_PER_SLOT ? { target: 'mj' } : { notice: '参考图已满' };
  }
  return slots.counts.images < maxReferenceImages(slots.model) ? { target: 'images' } : { notice: '参考图已满' };
}

function routeTimed(slots: StudioMediaSlots, media: 'videos' | 'audios'): StudioMediaRoute {
  const label = media === 'videos' ? '视频' : '音频';
  if (slots.kind !== 'video' || slots.videoMode !== 'omni') return { notice: `当前模式不支持${label}参考` };
  const limit = slots.videoCaps ? videoReferenceLimits(slots.videoCaps, 'omni')[media] : 0;
  if (limit < 1) return { notice: `当前模型不支持${label}参考` };
  return slots.counts[media] < limit ? { target: media } : { notice: `参考${label}已满` };
}

/** 按 mime 把媒体资产分到参考图 / 参考视频 / 参考音频；当前模式或模型收不了就给一句提示。 */
export function routeStudioMediaAsset(mimeType: string, slots: StudioMediaSlots): StudioMediaRoute {
  if (mimeType.startsWith('image/')) return routeImage(slots);
  if (mimeType.startsWith('video/')) return routeTimed(slots, 'videos');
  if (mimeType.startsWith('audio/')) return routeTimed(slots, 'audios');
  return { notice: '不支持这种文件' };
}
