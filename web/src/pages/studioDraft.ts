import type { MjRefSlots } from '@/components/studio/MjReferenceSlots';
import type { FrameSlots } from '@/components/studio/VideoReferenceAssets';
import type { Quality } from '@/lib/imageControlCaps';
import type { MjParams } from '@/lib/mjParams';
import type { VideoMode, VideoQuality } from '@/lib/videoControlCaps';
import type { JobKind, JobParams } from '@/schema/jobs';

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
  promptAssetId?: string | null;
  referenceImages: File[];
  referenceVideos: File[];
  referenceAudios: File[];
  videoFrames: FrameSlots;
  mjRefs: MjRefSlots;
  mjParams: MjParams;
  sizeParams: JobParams;
  count: number;
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

export type StudioMode = 'creation' | 'agent';
type StudioView = { mode: StudioMode; activeSessionId: string | null };

export function readStudioView(): StudioView {
  try {
    const saved = JSON.parse(sessionStorage.getItem('studio:view') ?? '{}');
    return { mode: saved.mode === 'agent' ? 'agent' : 'creation',
      activeSessionId: typeof saved.activeSessionId === 'string' ? saved.activeSessionId : null };
  } catch { return { mode: 'creation', activeSessionId: null }; }
}

export function updateStudioView(change: Partial<StudioView>) {
  try { sessionStorage.setItem('studio:view', JSON.stringify({ ...readStudioView(), ...change })); }
  catch { /* 当前页面仍可继续对话。 */ }
}
