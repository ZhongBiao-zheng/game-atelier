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

/** 每段对话各自的未提交输入：切到别的对话再切回来，提示词和参考素材原样回来。同样只活在内存里。 */
export interface StudioSessionInput {
  promptText: string;
  promptAssetSourceTitle: string | null;
  promptAssetId: string | null;
  referenceImages: File[];
  referenceVideos: File[];
  referenceAudios: File[];
  videoFrames: FrameSlots;
  mjRefs: MjRefSlots;
  agentText: string;
  agentFiles: File[];
}

/** 还没建会话的「新对话」用这个键存草稿。 */
export const NEW_SESSION_DRAFT_KEY = '__new__';
const sessionInputs = new Map<string, StudioSessionInput>();

export function readSessionInput(key: string): StudioSessionInput | undefined {
  return sessionInputs.get(key);
}

export function writeSessionInput(key: string, input: StudioSessionInput): void {
  sessionInputs.set(key, input);
}

export function deleteSessionInput(key: string): void {
  sessionInputs.delete(key);
}

export type StudioInputMode = 'agent' | 'image' | 'video';
export const DEFAULT_STUDIO_SESSION_ID = 'session-default-studio';
type StudioView = { inputMode: StudioInputMode; activeSessionId: string | null };

export function readStudioView(): StudioView {
  try {
    const saved = JSON.parse(sessionStorage.getItem('studio:view') ?? '{}');
    return { inputMode: saved.inputMode === 'video' || saved.inputMode === 'agent' ? saved.inputMode : 'image',
      activeSessionId: typeof saved.activeSessionId === 'string' || saved.activeSessionId === null ? saved.activeSessionId : DEFAULT_STUDIO_SESSION_ID };
  } catch { return { inputMode: 'image', activeSessionId: DEFAULT_STUDIO_SESSION_ID }; }
}

export function updateStudioView(change: Partial<StudioView>) {
  try { sessionStorage.setItem('studio:view', JSON.stringify({ ...readStudioView(), ...change })); }
  catch { /* 当前页面仍可继续对话。 */ }
}
