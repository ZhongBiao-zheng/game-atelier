import { markUnsavedChanges } from '@/api/connection';
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
 * 有没生成过的输入时登记未保存（见 `markStudioInputSubmitted`），服务换版本不自动刷新。
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
/** 草稿属于哪段对话的输入（完整版按当前对话，紧凑版固定默认对话）：和那段对话最近一次提交的输入比。 */
let draftSessionKey: string | null = null;

export function readStudioDraft(): StudioDraft | null {
  return draft;
}

export function writeStudioDraft(next: StudioDraft, sessionKey: string | null = null): void {
  draft = next;
  draftSessionKey = sessionKey;
  syncUnsaved();
}

export function clearStudioDraft(): void {
  draft = null;
  draftSessionKey = null;
  syncUnsaved();
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
  syncUnsaved();
}

export function deleteSessionInput(key: string): void {
  sessionInputs.delete(key);
  submittedInputs.delete(key);
  syncUnsaved();
}

/**
 * 未提交的输入登记成「未保存」：服务换了新版本时不自动刷新页面（刷新会清空内存里的提示词和参考），
 * 由用户选。已经生成过的输入不算——它在记录里，重新编辑就能取回。
 */
type TrackedInput = Pick<StudioSessionInput,
  'promptText' | 'referenceImages' | 'referenceVideos' | 'referenceAudios' | 'videoFrames' | 'mjRefs'>
  & Partial<Pick<StudioSessionInput, 'agentText' | 'agentFiles'>>;
const submittedInputs = new Map<string, TrackedInput>();

/** 这段对话的输入刚提交成功：之后没改动就不算未保存。 */
export function markStudioInputSubmitted(sessionKey: string, input: TrackedInput): void {
  submittedInputs.set(sessionKey, input);
  syncUnsaved();
}

function inputFiles(input: TrackedInput): (File | null)[] {
  return [
    ...input.referenceImages, ...input.referenceVideos, ...input.referenceAudios,
    input.videoFrames.first, input.videoFrames.last, ...Object.values(input.mjRefs).flat(),
    ...(input.agentFiles ?? []),
  ];
}

function hasInput(input: TrackedInput): boolean {
  return Boolean(input.promptText.trim() || input.agentText?.trim() || inputFiles(input).some(Boolean));
}

function sameInput(a: TrackedInput, b: TrackedInput): boolean {
  const filesA = inputFiles(a);
  const filesB = inputFiles(b);
  return a.promptText === b.promptText && (a.agentText ?? '') === (b.agentText ?? '')
    && filesA.length === filesB.length && filesA.every((file, index) => file === filesB[index]);
}

function unsavedInput(key: string | null, input: TrackedInput): boolean {
  if (!hasInput(input)) return false;
  const submitted = key === null ? undefined : submittedInputs.get(key);
  return !submitted || !sameInput(input, submitted);
}

function syncUnsaved(): void {
  const unsaved = (draft !== null && unsavedInput(draftSessionKey, draft))
    || [...sessionInputs].some(([key, input]) => unsavedInput(key, input));
  markUnsavedChanges('studio-input', unsaved);
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
