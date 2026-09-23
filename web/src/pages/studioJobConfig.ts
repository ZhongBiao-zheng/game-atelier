import type { KeyView } from '@/api/keys';
import type { RoundConfig } from '@/components/studio/RoundList';
import { imageSizeMode } from '@/lib/imageSizeMode';
import { mjParamsFromJob } from '@/lib/mjParams';
import { imageFamily } from '@/lib/modelFamily';
import type { VideoFrameMode } from '@/lib/videoControlCaps';
import type { Job, JobParams } from '@/schema/jobs';

export interface ReferenceCounts { images: number; videos: number; audios: number }

const VIDEO_FRAME_MODES: readonly VideoFrameMode[] = ['auto', 'first', 'last', 'firstlast'];
const IMAGE_SIZE_MODES: readonly NonNullable<JobParams['size_mode']>[] = ['auto', 'ratio', 'custom'];

/** 带视频/音频参考、或参考图没有帧语义（无 frame_mode / auto）→ 全能参考，否则首尾帧。 */
export function isOmniVideoConfig(frameMode: VideoFrameMode | undefined, counts: ReferenceCounts): boolean {
  return Boolean(
    counts.videos
    || counts.audios
    || (counts.images && (!frameMode || frameMode === 'auto'))
  );
}

/** RoundConfig 上三组参考路径的数量，供 isOmniVideoConfig 判定。 */
export function referencePathCounts(config: RoundConfig): ReferenceCounts {
  return {
    images: config.referenceImages.length,
    videos: config.referenceVideos?.length ?? 0,
    audios: config.referenceAudios?.length ?? 0,
  };
}

export function referenceImagesFor(job: Job): string[] {
  const params = job.params ?? {};
  const refs = [
    job.source_image,
    ...(Array.isArray(params.reference_images) ? params.reference_images : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  // 同一资产可能因 data root 迁移（旧仓 game-ui-ai-workflow → 分离后的 game-atelier）以不同前缀
  // 重复登记：source_image 存新路径（可渲染）、reference_images 仍是旧仓路径（文件已不在 → 裂图）。
  // 按尾段（角色/槽位/文件名）去重并保留首个（source_image 在前＝有效路径），消除历史里
  // 「一张有效 + 一张裂图」的重复缩略图。本地上传走 .runtime/uploads/<uuid> 尾段唯一，不会误并。
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    const key = ref.startsWith('http') ? ref : ref.split('/').slice(-3).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export function configForJob(job: Job, keys: KeyView[] = []): RoundConfig {
  const selectedKey = keys.find((item) => item.alias === job.alias);
  const selectedModel = selectedKey?.models.find((item) => item.id === job.model);
  const isVideo = job.kind === 'video';
  // 记录统一后更多 job 流经此处（含 skill 出图 / 乐观提交回包），params 缺省给 {} 兜底，免渲染期崩溃。
  const p = job.params ?? {};
  return {
    prompt: job.prompt ?? '',
    kind: isVideo ? 'video' : 'image',
    alias: job.alias,
    provider: job.provider,
    model: job.model,
    modelName: selectedModel?.name,
    ratio: typeof p.ratio === 'string' ? p.ratio : undefined,
    resolution: ['512', '1K', '2K', '4K'].includes(p.resolution ?? '') ? p.resolution as RoundConfig['resolution'] : undefined,
    size: typeof p.size === 'string' ? p.size : undefined,
    // 非法 size_mode 当缺省处理，交给 imageSizeMode 按 size 推断。
    sizeMode: imageSizeMode({ ...p, size_mode: enumValue(p.size_mode, IMAGE_SIZE_MODES) }),
    n: typeof p.n === 'number' ? clampImageCount(p.n) : undefined,
    quality: (p.quality === 'low' || p.quality === 'medium'
      || p.quality === 'high' || p.quality === 'auto')
      ? p.quality
      : undefined,
    referenceImages: referenceImagesFor(job),
    sourceAssetTitle: typeof p.creation_asset_source_title === 'string'
      ? p.creation_asset_source_title
      : undefined,
    // 后端跑 job 时回写的静默改写提示（尺寸归一化 / 参考图截断）——两端 schema 早有此字段。
    warnings: stringList(p.warnings),
    // MJ 参数从 job 还原：编辑导入 / 再次生成不带上就等于拿默认值重出一张不一样的图。
    ...(imageFamily(job.model) === 'midjourney'
      ? {
          mjParams: mjParamsFromJob(p),
          mjFlags: typeof p.mj_flags === 'string' ? p.mj_flags : undefined,
          mjRefPaths: {
            sref: stringList(p.mj_sref),
            cref: stringList(p.mj_cref),
            oref: stringList(p.mj_oref),
          },
        }
      : {}),
    // 视频参数：再次生成时从原 job 还原（上面只认图片分辨率档位，视频的 720p/1080p 存这里）。
    // referenceVideos/Audios 给空数组而非 undefined，避免 onSubmitVideo 的 ?? 回落到当前表单文件。
    ...(isVideo
      ? {
          duration: typeof p.duration === 'number' ? p.duration : undefined,
          videoResolution: typeof p.resolution === 'string' ? p.resolution : undefined,
          videoQuality: (p.mode === 'std' || p.mode === 'pro') ? p.mode : undefined,
          frameMode: enumValue(p.frame_mode, VIDEO_FRAME_MODES),
          generateAudio: p.generate_audio === true,
          referenceVideos: stringList(p.reference_videos),
          referenceAudios: stringList(p.reference_audios),
        }
      : {}),
  };
}

export function clampImageCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? 1), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(4, Math.max(1, Math.floor(parsed)));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? value as T : undefined;
}
