import type { MjRefSlots } from '@/components/studio/MjReferenceSlots';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import type { Quality } from '@/lib/imageControlCaps';
import type { MjParams } from '@/lib/mjParams';
import type { VideoMode, VideoQuality } from '@/lib/videoControlCaps';
import type { JobKind } from '@/schema/jobs';

/**
 * 创作台未提交的输入（提示词、参考素材、当前配置）。
 *
 * 只活在内存里：切到设置页加模型再回来，路由把 Studio 卸载又重建，这里的快照让输入原样回来；
 * 刷新页面就清空，与「出图配置每次启动回默认」一致。参考图是 File 对象，也只能这样留。
 * 首页的紧凑创作台与完整创作台共用同一份。
 */
export interface StudioDraft {
  providerAlias: string;
  model: string;
  kind: JobKind;
  promptText: string;
  promptAssetSourceTitle: string | null;
  referenceImages: File[];
  referenceVideos: File[];
  referenceAudios: File[];
  videoFrames: FrameSlots;
  mjRefs: MjRefSlots;
  mjParams: MjParams;
  ratio: string;
  resolution: '2K' | '4K';
  count: number;
  customSize: string;
  customSizeManual: boolean;
  quality: Quality;
  videoMode: VideoMode;
  duration: number;
  videoResolution: string;
  videoRatio: string;
  videoQuality: VideoQuality;
  videoCount: number;
  generateAudio: boolean;
}

let draft: StudioDraft | null = null;

export function readStudioDraft(): StudioDraft | null {
  return draft;
}

export function writeStudioDraft(next: StudioDraft): void {
  draft = next;
}

export function clearStudioDraft(): void {
  draft = null;
}
