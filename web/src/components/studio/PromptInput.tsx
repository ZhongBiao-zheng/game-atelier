import { ControlButton } from './ControlButton';
import { WorkflowParameters } from './WorkflowParameters';
import { compatibleWorkflowValues, workflowReferenceError } from '@/lib/workflowInputs';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { ModelBrandIcon } from '@/components/ModelBrandIcon';
import { type KeyboardEvent, type ReactNode, type RefObject, useImperativeHandle, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openOnboarding } from '@/lib/onboardingGuide';
import { AddIcon, AiIcon, ArrowUpIcon, StopIcon, AspectRatioIcon, AudioIcon, ChevronRightIcon, CloseIcon, CollapseIcon, ExpandIcon, ImageIcon, ImagesIcon, LibraryIcon, SaveAssetIcon, VideoIcon, WorkflowIcon, iconMarkup } from '@/components/ui/icons';
import { prefetchModelPickerMetrics } from '@/lib/useModelPickerMetrics';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { ModelPickerList } from '@/components/ModelPickerList';
import { modelBrand, modelDisplayName, sortModels } from '@/lib/modelCatalog';
import { modelModality, type KeyView } from '@/api/keys';
import { hasImageSizeSelection, imageSizeMode, imageSizeSummary, imageSizeError, normalizeImageSizeParams } from '@/lib/imageSizeMode';
import { isAutoProvider, sizeContext } from '@/lib/modelRoutes';
import { localComfyUrl, useComfyStatus } from '@/lib/useComfyStatus';
import { normalizeImagePixelSize } from '@/lib/studioSize';
import { ImageSizeFields } from './ImageSizeFields';
import { GptImage26Fields } from './GptImage26Fields';
import { TransparentBackgroundField } from './TransparentBackgroundField';
import { providerLabel } from '@/lib/providerLabels';
import { promptVariableError, promptVariableParts, readablePromptVariables, resolvePromptVariables } from '@/lib/promptVariables';
import { focusEmptyVariable, syncVariableInput, variableInput, variablePromptNodes } from '@/lib/promptVariableEditor';
import { maxReferenceImages } from '@/lib/referenceLimits';
import { imageFamily, isEvolinkMidjourney } from '@/lib/modelFamily';
import {
  MJ_IMAGES_PER_TASK,
  QUALITY_LABELS,
  type Quality,
} from '@/lib/imageControlCaps';
import { evolinkMjParams, hasSrefCode, MJ_DEFAULTS, type MjParams } from '@/lib/mjParams';
import { MjControls } from './MjControls';
import { EMPTY_MJ_REFS, MjReferenceSlots, type MjRefSlots } from './MjReferenceSlots';
import { captureVideoFrame } from '@/lib/videoFrame';
import { VideoControls } from './VideoControls';
import {
  FirstLastFrames,
  MAX_REF_AUDIOS,
  MAX_REF_IMAGES,
  MAX_REF_VIDEOS,
  type FrameSlots,
} from './VideoReferenceAssets';
import { Lightbox } from '../Lightbox';
import { ToolbarPopover } from './ToolbarPopover';
import type { VideoControlCaps, VideoMode, VideoQuality } from '@/lib/videoControlCaps';
import type { StudioInputMode } from '@/pages/studioDraft';
import type { JobParams } from '@/schema/jobs';
import {
  canonicalMentionLabel,
  createMentionTokenRegex,
  mentionTokenPatternForLabel,
} from '@/lib/mentionTokens';
import { FileInput } from '@/components/ui/file-input';
import { Hint } from '@/components/ui/tooltip';
import { Collapse } from '@/components/ui/collapse';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, shakeOnError, useAnimateOnChange, motionAvailable, prefersReducedMotion } from '@/lib/motion';
import { ReferenceItemMotion, useArrivingKeys, useFileKeys, useLeavingRefs, useSlideOnReorder, withLeaving } from './ReferenceMotion';
import { SwapIcon } from '@/components/ui/swap-icon';
import { MentionTabs, SubjectFeedback, subjectChip, subjectToken, useSubjects, withSubjectChips } from '@/components/assets/SubjectMentions';
import { itemThumb } from '@/api/library';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface Props {
  onSubmit: (prompt: string, promptTemplate?: string) => void | Promise<void>;
  disabled?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  /** 外部资产面板要求在最后一次编辑光标处插入文本。 */
  insertTextRequest?: { requestId: string; text: string } | null;
  onSavePromptAsset?: () => void;
  onToggleAssetPanel?: () => void;
  assetPanelOpen?: boolean;
  providers?: KeyView[];
  providerAlias?: string;
  model?: string;
  sizeParams?: JobParams;
  onSizeParamsChange?: (patch: JobParams) => void;
  count?: number;
  onProviderChange?: (alias: string) => void;
  onModelChange?: (model: string) => void;
  onCountChange?: (count: number) => void;
  quality?: Quality;
  onQualityChange?: (quality: Quality) => void;
  /** Midjourney 专属参数（family=midjourney 时才渲染面板）。 */
  mjParams?: MjParams;
  onMjParamsChange?: (patch: Partial<MjParams>) => void;
  /** MJ 的三个语义参考槽（风格 / 角色 / Omni）。垫图仍走通用参考图栏位。 */
  mjRefs?: MjRefSlots;
  onMjRefsChange?: (refs: MjRefSlots) => void;
  menuDirection?: 'up' | 'down';
  /** Studio 滚动联动：true 时收成单行胶囊（控件行折叠、参考区缩放、rounded-full）。 */
  collapsed?: boolean;
  /** 收缩态被点击（用户想输入）——父级应展开但不滚动。 */
  onExpandRequest?: () => void;
  /** 焦点进出输入壳；父级用它在输入期间保持展开。 */
  onShellFocusChange?: (focused: boolean) => void;
  referenceImages?: File[];
  onReferenceImagesChange?: (files: File[]) => void;
  // --- video mode (optional; only used when kind === 'video') ---
  kind?: StudioInputMode;
  inputRef?: RefObject<HTMLDivElement>;
  agentControls?: ReactNode;
  onStop?: () => void;
  onKindChange?: (kind: StudioInputMode) => void;
  videoMode?: VideoMode;
  videoCaps?: VideoControlCaps;
  duration?: number;
  videoResolution?: string;
  videoRatio?: string;
  videoQuality?: VideoQuality;
  videoCount?: number;
  generateAudio?: boolean;
  onVideoModeChange?: (mode: VideoMode) => void;
  onDurationChange?: (duration: number) => void;
  onVideoResolutionChange?: (resolution: string) => void;
  onVideoRatioChange?: (ratio: string) => void;
  onVideoQualityChange?: (quality: VideoQuality) => void;
  onVideoCountChange?: (count: number) => void;
  videoSeed?: number;
  onClearVideoSeed?: () => void;
  onGenerateAudioChange?: (generateAudio: boolean) => void;
  referenceVideos?: File[];
  referenceAudios?: File[];
  onReferenceVideosChange?: (files: File[]) => void;
  onReferenceAudiosChange?: (files: File[]) => void;
  videoFrames?: FrameSlots;
  onVideoFramesChange?: (frames: FrameSlots) => void;
  /** 提交失败的标识（错误文案或计数）：每次变成新的非空值，提交按钮水平微抖一次。 */
  submitErrorKey?: string | number | null;
  /** 从记录里带进来的内容落在哪：每个新 id 让那一块闪一次主题色描边。 */
  flashRequest?: InputFlashRequest | null;
  /** 提交按钮旁常显的估价（「4 张 · 约 ¥1.40」）；null = 未计价，不显示。 */
  estimateLabel?: string | null;
  /** 输入壳上方的状态条：一次选的参考超过上限时说明只加入了几张。 */
  onNotice?: (text: string) => void;
}

export type InputFlashRequest = { id: number; area: 'prompt' | 'references' };

/** 带入提示：描边 300ms 亮起，停一下，再 300ms 褪掉（跟随所在行的收放时长与曲线）。 */
const INPUT_FLASH_HOLD_MS = 600;

const REF_W = 48;
const REF_H = 60;
const REF_STEP = 42;
// 折叠堆叠时按 index 取的旋转角度（循环），制造层次让用户看到下面的图
const COLLAPSE_ANGLES = [8, -4, 22, -8, 8, -4];
const collapseAngle = (i: number) => COLLAPSE_ANGLES[i % COLLAPSE_ANGLES.length];
// hover 单张时微放大（与图片卡片统一 1.02）+ 微上抬
const REF_HOVER_SCALE = 1.02;
const REF_HOVER_LIFT = -5;

function providerName(provider?: KeyView) {
  if (!provider) return '未配置供应商';
  return providerLabel(provider.provider, provider.alias);
}

/** @引用的素材类目标签。契约（seedance 官方 / happyhorse [Image N]）按「类型 + 序号」指代素材。 */
const MENTION_LABELS = { image: '图', video: '视频', audio: '音频' } as const;

/** 参考区显示的一张素材。live 是它在当前素材里的下标；为 null 时是删除后正在退场的缩略图副本。 */
interface ReferenceEntry {
  key: string;
  kind: keyof typeof MENTION_LABELS;
  file: File;
  thumb: string | null;
  url: string;
  label: string | undefined;
  live: number | null;
}

/** 删除素材后重写 prompt 里的 @引用：被删序号的引用移除，更大序号依次前移。 */
export function renumberMentions(input: string, label: string, removed: number): string {
  const token = mentionTokenPatternForLabel(label);
  return input.replace(new RegExp(`@${token}(\\d+)`, 'g'), (match, num: string) => {
    const n = parseInt(num, 10);
    if (n === removed) return '';
    if (n > removed) return `@${label}${n - 1}`;
    return match;
  });
}

/** 提交序列化：@图1 → 图1。API 契约靠序号自然语言绑定素材，@ 只是输入框里的交互糖。 */
export function serializeMentions(prompt: string): string {
  return prompt.replace(createMentionTokenRegex(), (_match, kind: string, n: string) => (
    canonicalMentionLabel(kind, n)
  ));
}

// ---- @引用 chip 化：编辑器 DOM 与 prompt 字符串互转 ----
// 编辑器是 contentEditable（chip 是 contentEditable=false 的原子 span，整删 / hover 预览），
// 但状态层仍是带 @图N 字面量的纯字符串——重编号 / 序列化逻辑因此完全不变。

type ChipMeta = { kind: 'image' | 'video' | 'audio'; thumb: string | null };

/** chip 走命令式 DOM 构建，用不了 React 图标组件；SVG 字符串取自同一份图标数据。 */
const CHIP_ICON_SVG: Record<'video' | 'audio', string> = {
  video: iconMarkup(VideoIcon, 'sm'),
  audio: iconMarkup(AudioIcon, 'sm'),
};

function decorateChip(span: HTMLSpanElement, label: string, meta: ChipMeta | undefined) {
  span.textContent = '';
  const kind = meta?.kind
    ?? (label.startsWith('视频') ? 'video' : label.startsWith('音频') ? 'audio' : 'image');
  if (meta?.thumb) {
    const img = document.createElement('img');
    img.src = meta.thumb;
    img.alt = '';
    img.className = 'h-[18px] w-[18px] rounded-sm object-cover';
    span.appendChild(img);
  } else if (kind !== 'image') {
    const icon = document.createElement('span');
    icon.className = 'grid h-[18px] w-[18px] place-items-center rounded-sm bg-secondary text-muted-foreground';
    icon.innerHTML = CHIP_ICON_SVG[kind];
    span.appendChild(icon);
  }
  span.appendChild(document.createTextNode(label));
}

function buildChipEl(label: string, meta: ChipMeta | undefined): HTMLSpanElement {
  const span = document.createElement('span');
  span.setAttribute('data-mention', label);
  span.contentEditable = 'false';
  span.className = 'inline-flex select-none items-center gap-1 align-middle text-primary cursor-default';
  decorateChip(span, label, meta);
  return span;
}

/** 编辑器 DOM → prompt 字符串：chip 还原成 @图N 字面量，块级/BR 还原成换行。 */
export function domToText(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.subjectToken) { out += el.dataset.subjectToken; return; }
    if (el.dataset.promptVariable) {
      out += el.dataset.promptVariable;
      return;
    }
    const label = el.getAttribute('data-mention');
    if (label) {
      out += `@${label}`;
      return;
    }
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    // 浏览器偶发把行包进 div/p（粘贴残留等）——按换行还原
    if ((el.tagName === 'DIV' || el.tagName === 'P') && out && !out.endsWith('\n')) out += '\n';
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out.replace(/\u00a0/g, ' ');
}

export function PromptInput({
  onSubmit,
  disabled,
  value,
  onValueChange,
  insertTextRequest,
  onSavePromptAsset,
  onToggleAssetPanel,
  assetPanelOpen,
  providers = [],
  providerAlias,
  model,
  sizeParams = { size_mode: 'ratio', ratio: '1:1', resolution: '2K' },
  onSizeParamsChange,
  count = 1,
  onProviderChange,
  onModelChange,
  onCountChange,
  quality = 'medium' as Quality,
  mjParams = MJ_DEFAULTS,
  onMjParamsChange,
  mjRefs = EMPTY_MJ_REFS,
  onMjRefsChange,
  onQualityChange,
  menuDirection = 'up',
  collapsed = false,
  onExpandRequest,
  onShellFocusChange,
  referenceImages = [],
  onReferenceImagesChange,
  kind = 'image',
  onKindChange, inputRef, agentControls, onStop,
  videoMode = 'firstlast',
  videoCaps,
  duration = 5,
  videoResolution = '720p',
  videoRatio = '16:9',
  videoQuality,
  videoCount = 1,
  generateAudio = false,
  onVideoModeChange,
  onDurationChange,
  onVideoResolutionChange,
  onVideoRatioChange,
  onVideoQualityChange,
  onVideoCountChange,
  onGenerateAudioChange,
  videoSeed,
  onClearVideoSeed,
  referenceVideos = [],
  referenceAudios = [],
  onReferenceVideosChange,
  onReferenceAudiosChange,
  videoFrames = { first: null, last: null },
  onVideoFramesChange,
  submitErrorKey,
  flashRequest,
  estimateLabel = null,
  onNotice,
}: Props) {
  const isVideo = kind === 'video';
  const isAgent = kind === 'agent';
  const ActionIcon = isAgent && onStop ? StopIcon : ArrowUpIcon;
  const [internalText, setInternalText] = useState('');
  const text = value ?? internalText;
  const setText = onValueChange ?? setInternalText;
  const [openPanel, setOpenPanel] = useState<'kind' | 'provider' | 'model' | 'size' | 'count' | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const [flashArea, setFlashArea] = useState<InputFlashRequest['area'] | null>(null);
  useEffect(() => {
    if (!flashRequest) return;
    setFlashArea(flashRequest.area);
    const timer = window.setTimeout(() => setFlashArea(null), INPUT_FLASH_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [flashRequest]);
  // 提交失败：只抖提交按钮这一处局部元素，错误文案由调用方用错误色显示。
  useAnimateOnChange(submitErrorKey ?? null, next => {
    if (next != null && next !== '') shakeOnError(submitButtonRef.current);
  });
  // 控件 chip 外壳锚点：弹窗 portal 出横滚容器后靠这些 ref 定位。
  const kindRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  // 控件行横滚：track 容器 + 是否还能右滚 + 底栏 hover（决定右缘箭头是否浮现）。
  const trackRef = useRef<HTMLDivElement>(null);
  // 切换 图片 / 视频 / Agent：控件行整排换成另一套，新的一排 150ms 淡入，不硬切。
  useAnimateOnChange(kind, (_next, _previous, reduced) => {
    const element = trackRef.current;
    if (!element) return;
    clearOnFinish(animate(element, reduced ? { opacity: [0, 1] } : { opacity: [0, 1], x: [-4, 0] },
      { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }), element);
  }, { keepWhenReduced: true });
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [barHovering, setBarHovering] = useState(false);
  const [refExpanded, setRefExpanded] = useState(false);
  const [refHovered, setRefHovered] = useState<number | null>(null);
  const [refDrawerOpen, setRefDrawerOpen] = useState(false);
  const [refDrawerTab, setRefDrawerTab] = useState<'all' | 'image' | 'video' | 'audio'>('all');
  const isLongPrompt = text.length > 140 || text.split('\n').length > 4;
  // 参考图槽位的大图层（堆叠里的图片素材点开）。Lightbox 自带 portal：壳上的
  // backdrop-filter 会给 fixed 后代造 containing block，挂在壳内的 fixed 会缩进壳里。
  const [slotLightbox, setSlotLightbox] = useState<string | null>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const refInputId = useId();
  const variableErrorId = useId();
  // @引用编辑器：contentEditable DOM 是输入现场，text 字符串是状态层；
  // lastSynced 区分「用户输入回流」与「外部改写」——只有外部改写才重建 DOM。
  const editorRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(inputRef, () => editorRef.current!, []);
  const lastEditorRange = useRef<Range | null>(null);
  const handledInsertRequest = useRef<string | null>(null);
  const lastSynced = useRef<string | null>(null);
  const composing = useRef(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionTab, setMentionTab] = useState('all');
  const subjects = useSubjects(!isAgent && (mentionOpen || text.includes('@[subject:')));
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;
  // chip hover 预览：标签 + fixed 锚点坐标（portal 到 body，浮在参考内容上方）
  const [chipHover, setChipHover] = useState<{ label: string; left: number; top: number } | null>(null);
  // 厂商/模型列表按当前生成类型过滤：模型级 modality 标注优先，未标注按 key 级 modalities 兜底。
  const wantedModality = isVideo ? 'video' : 'image';
  const visibleModel = (m: KeyView['models'][number], p: KeyView) => modelModality(m, p) === wantedModality
    && (p.provider !== 'evolink' || (isEvolinkMidjourney(m.id, p.provider) && (!m.protocol || m.protocol === 'evolink')));
  const visibleProviders = providers.filter(
    (p) => (p.models ?? []).some((m) => visibleModel(m, p)),
  );
  const provider = visibleProviders.find((item) => item.alias === providerAlias) ?? visibleProviders[0];
  const providerDisplayName = providerName(provider);
  const models = sortModels(provider?.models.filter((m) => visibleModel(m, provider)) ?? []);
  const pickerChoices = (provider?.models ?? []).filter(m =>
    ['image', 'video'].includes(modelModality(m, provider))
    && (provider?.provider !== 'evolink' || isEvolinkMidjourney(m.id, provider.provider))
  ).map(model => ({ key: provider!, model }));
  // 模型不在当前列表时模型位空着、不能生成，不偷偷换成第一个模型：换类型后的收敛由上层做。
  const selectedModel = isAgent ? undefined : models.find((item) => item.id === model);
  const { status: comfyStatus, recheck: recheckComfy } = useComfyStatus(isAgent ? null : localComfyUrl(provider, selectedModel));
  const comfyStopped = comfyStatus === 'stopped';
  const workflowInputs = selectedModel?.workflow_inputs;
  const fixedWorkflowSeed = workflowInputs?.some(input => input.type === 'seed' && sizeParams.workflow_inputs?.[input.id] != null) ?? false;
  const noWorkflowPrompt = workflowInputs != null && !workflowInputs.some(input => input.type === 'prompt');
  const workflowReferenceProblem = workflowReferenceError(workflowInputs, referenceImages.length, Boolean(sizeParams.mask_image));
  const isOmni = isVideo && videoMode === 'omni' && Boolean(videoCaps);
  // @引用开放给两类入口：视频「全能参考」(omni)，以及图片图生图（MJ 除外）。@ 提交时只剩
  // 「图N」字面量（见 serializeMentions），能不能吃到取决于模型是否按输入顺序理解序号：
  // seedream 官方 prompt 示例直接写「图1 / 图2」，gpt-image / nano-banana 是多模态模型、
  // 输入数组有序；MJ 的参考图走 --sref/--cref 等 flag，prompt 文本里的「图1」对它没有意义，
  // 开了就是骗人的糖。视频首尾帧模式也不开：两张图各有固定语义槽位，不靠序号指代。
  const mentionsEnabled = isOmni
    || (!isVideo && Boolean(onReferenceImagesChange) && imageFamily(selectedModel?.id) !== 'midjourney');
  // 参考堆叠的数据源：图片模式只有参考图；omni 模式图/视频/音频混排进同一叠扇形。
  const stackItems = useMemo(() => {
    const images = referenceImages.map((file) => ({ kind: 'image' as const, file }));
    if (!isOmni) return images;
    return [
      ...images,
      ...referenceVideos.map((file) => ({ kind: 'video' as const, file })),
      ...referenceAudios.map((file) => ({ kind: 'audio' as const, file })),
    ];
  }, [isOmni, referenceImages, referenceVideos, referenceAudios]);
  // 全类型素材都建 objectURL：图片直接当缩略图，视频喂给抽帧 + hover 预览播放，音频留给预览卡。
  const mediaUrls = useMemo(() => stackItems.map((item) => URL.createObjectURL(item.file)), [stackItems]);
  // 退场副本还在用的地址先不回收，副本卸载时再回收（见 removeRef）。
  const heldRefUrls = useRef(new Set<string>());
  useEffect(() => () => mediaUrls.forEach((u) => { if (!heldRefUrls.current.has(u)) URL.revokeObjectURL(u); }), [mediaUrls]);
  useEffect(() => {
    const held = heldRefUrls.current;
    return () => held.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  // 视频首帧缩略图（异步抽帧，按 objectURL 缓存）；抽不出来退回 Film 图标
  const [videoThumbs, setVideoThumbs] = useState<Record<string, string>>({});
  const thumbRequested = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    stackItems.forEach((item, i) => {
      const url = mediaUrls[i];
      if (item.kind !== 'video' || !url || thumbRequested.current.has(url)) return;
      thumbRequested.current.add(url);
      captureVideoFrame(url).then((thumb) => {
        if (alive && thumb) setVideoThumbs((prev) => ({ ...prev, [url]: thumb }));
      });
    });
    return () => { alive = false; };
  }, [stackItems, mediaUrls]);
  const thumbFor = useCallback((i: number) => {
    const item = stackItems[i];
    const url = mediaUrls[i];
    if (!item || !url) return null;
    if (item.kind === 'image') return url;
    if (item.kind === 'video') return videoThumbs[url] ?? null;
    return null;
  }, [stackItems, mediaUrls, videoThumbs]);
  // 每个素材的 @引用标签：按类目独立编号（图1、图2、视频1、音频1），与 content[] 顺序一致。
  const mentionItems = useMemo(() => {
    const counters = { image: 0, video: 0, audio: 0 };
    return stackItems.map((item, index) => ({
      ...item,
      index,
      label: `${MENTION_LABELS[item.kind]}${++counters[item.kind]}`,
    }));
  }, [stackItems]);
  // chip 元数据按标签索引；命令式构建路径（renderDom / insertMention）经 ref 取最新值。
  const chipMeta = useMemo(() => {
    const map = new Map<string, ChipMeta>();
    mentionItems.forEach((item) => map.set(item.label, { kind: item.kind, thumb: thumbFor(item.index) }));
    return map;
  }, [mentionItems, thumbFor]);
  const chipMetaRef = useRef(chipMeta);
  chipMetaRef.current = chipMeta;
  // 用 ref 让 renderDom（[] 依赖、命令式构建）能读到最新开关而不必进依赖数组。
  const mentionsEnabledRef = useRef(mentionsEnabled);
  mentionsEnabledRef.current = mentionsEnabled;

  /** prompt 字符串 → 编辑器 DOM：@图N 字面量渲染成原子 chip。仅外部改写时调用。 */
  const promptNodes = useCallback((value: string) => variablePromptNodes(value, part => withSubjectChips(part, subjectsRef.current, plain => {
    if (!mentionsEnabledRef.current) return [document.createTextNode(plain)];
    const nodes: Node[] = [];
    let last = 0;
    for (const m of plain.matchAll(createMentionTokenRegex())) {
      const idx = m.index ?? 0;
      if (idx > last) nodes.push(document.createTextNode(plain.slice(last, idx)));
      const label = canonicalMentionLabel(m[1], m[2]);
      nodes.push(buildChipEl(label, chipMetaRef.current.get(label)));
      last = idx + m[0].length;
    }
    if (last < plain.length) nodes.push(document.createTextNode(plain.slice(last)));
    return nodes;
  })), []);
  const renderDom = useCallback((value: string) => {
    editorRef.current?.replaceChildren(...promptNodes(value));
  }, [promptNodes]);

  /** 编辑器 DOM → 状态层。输入回流的唯一入口；lastSynced 同步防止 effect 重建 DOM。 */
  const syncFromDom = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    // 内容删空后浏览器残留的 <br> 会挡住 :empty placeholder
    if (root.childNodes.length === 1 && root.firstChild?.nodeName === 'BR') root.textContent = '';
    const parsed = domToText(root);
    lastSynced.current = parsed;
    setText(parsed);
  }, [setText]);

  // 外部改写（重编号 / 再次编辑回填 / 提交清空）→ 重建 DOM；光标语义已失效，聚焦时落到末尾。
  useEffect(() => {
    const rendered = noWorkflowPrompt ? '' : text;
    if (rendered === lastSynced.current) return;
    renderDom(rendered);
    lastSynced.current = rendered;
    const root = editorRef.current;
    if (root && focusEmptyVariable(root)) return;
    if (root && document.activeElement === root) {
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(root);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  }, [text, renderDom, noWorkflowPrompt]);

  useEffect(() => {
    editorRef.current?.querySelectorAll<HTMLElement>('[data-subject-token]').forEach(span => {
      span.replaceWith(subjectChip(span.dataset.subjectToken!, subjects));
    });
  }, [subjects]);

  // 视频抽帧是异步的：thumb 到位后原地补进已渲染的 chip，不重建 DOM（保光标）。
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLSpanElement>('[data-mention]').forEach((span) => {
      const label = span.getAttribute('data-mention') ?? '';
      const meta = chipMeta.get(label);
      if (meta?.thumb && !span.querySelector('img')) decorateChip(span, label, meta);
    });
  }, [chipMeta]);

  /** 光标前一字符是 @ 且有素材 → 弹引用菜单。 */
  const updateMentionMenu = useCallback(() => {
    if (isAgent && (!mentionsEnabled || stackItems.length === 0)) {
      setMentionOpen(false);
      return;
    }
    const sel = window.getSelection();
    let open = false;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (r.collapsed && r.startContainer.nodeType === Node.TEXT_NODE) {
        open = (r.startContainer.textContent ?? '')[r.startOffset - 1] === '@';
      }
    }
    if (open) setMentionTab('all');
    setMentionOpen(open);
  }, [mentionsEnabled, stackItems.length, isAgent]);

  /** 在光标处插入纯文本（Enter 换行 / 粘贴去格式共用）。execCommand 保原生撤销栈，jsdom 无则 Range 兜底。 */
  function insertPlainText(value: string) {
    const root = editorRef.current;
    if (!root) return;
    if (typeof document.execCommand === 'function') {
      document.execCommand('insertText', false, value);
      return; // execCommand 触发 input 事件 → onEditorInput 回流
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const node = document.createTextNode(value);
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    syncFromDom();
  }

  const rememberEditorRange = useCallback(() => {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (root.contains(range.startContainer) && root.contains(range.endContainer)) {
      lastEditorRange.current = range.cloneRange();
    }
  }, []);

  useEffect(() => {
    if (!insertTextRequest || handledInsertRequest.current === insertTextRequest.requestId) return;
    handledInsertRequest.current = insertTextRequest.requestId;
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const selection = window.getSelection();
    const saved = lastEditorRange.current;
    if (selection && saved && root.contains(saved.startContainer) && root.contains(saved.endContainer)) {
      selection.removeAllRanges();
      selection.addRange(saved);
    } else if (selection) {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const fragment = document.createElement('div');
    fragment.append(...promptNodes(insertTextRequest.text));
    if (fragment.querySelector('[data-prompt-variable]')) {
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertHTML', false, fragment.innerHTML);
      } else if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const nodes = document.createDocumentFragment();
        nodes.append(...fragment.childNodes);
        range.insertNode(nodes);
      }
      syncFromDom();
      focusEmptyVariable(root);
    } else {
      insertPlainText(insertTextRequest.text);
    }
    rememberEditorRange();
  }, [insertTextRequest, rememberEditorRange]); // eslint-disable-line react-hooks/exhaustive-deps

  function insertMention(label: string) {
    const root = editorRef.current;
    if (!root) return;
    // 先捕获 range 再 focus：focus() 可能把 selection 重置到编辑器起点（jsdom 实测会）
    const sel = window.getSelection();
    let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (range && !root.contains(range.startContainer)) range = null;
    const chip = label.startsWith('@[subject:') ? subjectChip(label, subjects) : buildChipEl(label, chipMetaRef.current.get(label));
    if (!range) {
      // 光标不在编辑器内（异常路径）：chip 追加到末尾，光标落到尾部
      root.appendChild(chip);
      root.appendChild(document.createTextNode(' '));
      root.focus();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(root);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } else {
      // 菜单由敲 @ 触发：把触发字符一并替换
      const n = range.startContainer;
      if (range.collapsed && n.nodeType === Node.TEXT_NODE && range.startOffset > 0
          && (n.textContent ?? '')[range.startOffset - 1] === '@') {
        range.setStart(n, range.startOffset - 1);
      }
      root.focus();
      sel!.removeAllRanges();
      sel!.addRange(range);
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertHTML', false, `${chip.outerHTML}&nbsp;`);
      } else {
        range.deleteContents();
        const space = document.createTextNode(' ');
        range.insertNode(space);
        range.insertNode(chip);
        range.setStartAfter(space);
        range.collapse(true);
        sel!.removeAllRanges();
        sel!.addRange(range);
      }
    }
    setMentionOpen(false);
    syncFromDom();
  }

  // 控件行能否右滚 → 决定右缘渐隐 + 箭头是否出现。内容（厂商/模型/模式）变化都会改 scrollWidth。
  const updateScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    updateScroll();
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScroll, isVideo, videoMode, model, providerAlias, providers, collapsed]);
  // 能力四项按模型族判（provider 只决定端点/协议，openrouter 另外改 size 语义）；「自动」取成员交集。
  const size = sizeContext(providers, provider, selectedModel?.id ?? '');
  const caps = size.caps;
  const sizeModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (isVideo || !selectedModel || !provider) {
      sizeModelRef.current = null;
      return;
    }
    const identity = `${provider.alias}:${selectedModel.id}:${provider.base_url ?? ''}`;
    const changedModel = sizeModelRef.current !== null && sizeModelRef.current !== identity;
    const initialize = sizeModelRef.current === null;
    sizeModelRef.current = identity;
    const context = sizeContext(providers, provider, selectedModel.id);
    const normalized = normalizeImageSizeParams(context.modelId, context.provider, context.baseUrl, sizeParams, context.caps);
    if (changedModel || initialize) {
      normalized.workflow_inputs = compatibleWorkflowValues(selectedModel.workflow_inputs, sizeParams.workflow_inputs);
    }
    const modeChanged = hasImageSizeSelection(sizeParams) && imageSizeMode(normalized) !== imageSizeMode(sizeParams);
    if (!modeChanged && (changedModel || initialize) && imageSizeMode(normalized) === 'custom' && !imageSizeError(normalized, context.modelId)) {
      const pixels = normalizeImagePixelSize(normalized.size!, context.modelId, context.baseUrl);
      normalized.size = pixels;
      normalized.custom_size = pixels;
    }
    if (JSON.stringify(normalized) !== JSON.stringify(sizeParams)) onSizeParamsChange?.(normalized);
  }, [isVideo, selectedModel, provider, providers, sizeParams, onSizeParamsChange]);
  const sizeControlDetail = caps.showResolution && imageSizeMode(sizeParams) === 'ratio'
    ? (sizeParams.resolution ?? (caps.sizeKind === 'ratio' ? null : '2K'))
    : caps.qualities?.length
      ? (QUALITY_LABELS[quality] ?? quality)
      : null;
  // MJ 的比例/版本/stylize 由渠道固定注入，张数也固定 4 —— 这些控件不能装作可选。
  const isMj = !isAgent && caps.family === 'midjourney';
  const isEvoMj = isEvolinkMidjourney(size.modelId, size.provider);
  const maxRef = isAgent ? 16 : caps.maxRefImages ?? maxReferenceImages(selectedModel?.id);
  // omni 参考上限：按族覆盖（happyhorse video-edit = 5 图 + 1 视频），缺省 9/3/3。
  const maxRefImgs = videoCaps?.maxRefImages ?? MAX_REF_IMAGES;
  const maxRefVids = videoCaps?.maxRefVideos ?? MAX_REF_VIDEOS;
  const maxRefAudios = videoCaps?.maxRefAudios ?? MAX_REF_AUDIOS;
  const stackAccept = isOmni
    ? ['image/*', videoCaps?.supportsReferenceVideo && 'video/*', videoCaps?.supportsReferenceAudio && 'audio/*']
        .filter(Boolean)
        .join(',')
    : 'image/*';
  const stackCanAdd = isOmni
    ? referenceImages.length < maxRefImgs ||
      (Boolean(videoCaps?.supportsReferenceVideo) && referenceVideos.length < maxRefVids) ||
      (Boolean(videoCaps?.supportsReferenceAudio) && referenceAudios.length < maxRefAudios)
    : referenceImages.length < maxRef;
  // Seedance（火山 Ark）与可灵 3.0 / 4.0 都不支持只给尾帧：last_frame 必须配 first_frame。只填尾帧槽时在客户端
  // 拦下并禁用生成，不浪费一轮注定被上游拒的 API 往返（其余族 / 模式 / 再次生成路径不受影响）。
  const lastFrameOnlyBlocked =
    isVideo &&
    videoMode === 'firstlast' &&
    (videoCaps?.family === 'seedance' || videoCaps?.family === 'klingai' || videoCaps?.family === 'vidu') &&
    (videoCaps?.maxFrames ?? 0) >= 2 &&
    !videoFrames?.first &&
    Boolean(videoFrames?.last);
  const variableError = isAgent || noWorkflowPrompt ? null : promptVariableError(text);
  const canSubmit = isAgent ? Boolean(!disabled && (text.trim() || referenceImages.length)) :
    Boolean(provider && selectedModel && (text.trim() || noWorkflowPrompt) && !disabled) && !lastFrameOnlyBlocked
      && !variableError
      && !workflowReferenceProblem
      && (isVideo || !imageSizeError(sizeParams, selectedModel?.id));
  const pickerParams = { image: { ...sizeParams, quality,
                  reference_images: referenceImages.map(() => 'reference'),
                }, video: {
                  duration, resolution: videoResolution, ratio: videoRatio, quality: videoQuality,
                  generate_audio: generateAudio,
                  reference_videos: referenceVideos.length ? ['reference'] : [],
                } };

  // 控件行右缘渐隐 + 箭头几何：悬停时为箭头让出 36px 槽位，渐隐带 40px 落在箭头左侧。
  const SCROLL_ARROW = 36;
  const SCROLL_FADE = 40;
  const scrollReserve = barHovering ? SCROLL_ARROW : 0;
  const scrollBlockWidth = scrollReserve + SCROLL_FADE;
  const trackMask =
    `linear-gradient(to right, black calc(100% - ${scrollBlockWidth}px), transparent calc(100% - ${scrollReserve}px))`;

  // 切换模型（16 张的 gpt-image → 3 张的 nano-banana）不截参考：超出上限的留在堆叠里置灰，
  // 提交时只发前 N 张（Studio 负责截取并在输入壳上方说明），换回模型后自动恢复。
  const refImagesLimit = isAgent ? null : isVideo ? (isOmni ? maxRefImgs : null) : maxRef;
  const overLimitImage = (item: { kind: string; live: number | null }) =>
    refImagesLimit !== null && item.kind === 'image' && item.live !== null && item.live >= refImagesLimit;

  const submit = useCallback(() => {
    if (isAgent) {
      if (canSubmit) void onSubmit(serializeMentions(text.trim()));
      return;
    }
    if (workflowReferenceProblem) return;
    if (!noWorkflowPrompt && promptVariableError(text)) {
      if (editorRef.current) focusEmptyVariable(editorRef.current, true);
      return;
    }
    // @图1 → 图1：API 按序号自然语言绑定素材，@ 不出现在最终 prompt 里。
    const template = noWorkflowPrompt ? '' : serializeMentions(text).trim();
    const trimmed = resolvePromptVariables(template).trim();
    if ((!trimmed && !noWorkflowPrompt) || disabled || !provider || !selectedModel || lastFrameOnlyBlocked || (!isVideo && imageSizeError(sizeParams, selectedModel?.id))) return;
    if (promptVariableParts(template).some(part => part.kind === 'variable')) onSubmit(trimmed, template);
    else onSubmit(trimmed);
  }, [isAgent, canSubmit, text, disabled, provider, selectedModel, onSubmit, lastFrameOnlyBlocked, isVideo, sizeParams, noWorkflowPrompt, workflowReferenceProblem]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (variableInput(e.target)) return;
    if (e.key === 'Escape' && mentionOpen) {
      e.preventDefault();
      setMentionOpen(false);
      return;
    }
    if (e.key !== 'Enter') return;
    // 输入法组合期（中文候选）按 Enter 是确认候选，既不提交也不换行。
    if (composing.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // 图片 / 视频会花钱：⌘↵ / Ctrl+↵ 提交，Enter 换行（D5）。Agent 是对话：Enter 发送，Shift+Enter 换行。
    const submits = isAgent ? !e.shiftKey : e.metaKey || e.ctrlKey;
    // 换行：contentEditable 原生 Enter 会包 <div>，统一改插 '\n'（pre-wrap 渲染换行）。
    if (submits) submit();
    else insertPlainText('\n');
  };

  function onEditorInput(e: React.FormEvent<HTMLDivElement>) {
    if (composing.current) return; // 中文输入法组合期不回流，compositionend 一次性同步
    const isVariable = editorRef.current && syncVariableInput(editorRef.current, e.target);
    syncFromDom();
    if (isVariable) setMentionOpen(false);
    else updateMentionMenu();
  }

  function onEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (variableInput(e.target)) return;
    e.preventDefault();
    const editor = editorRef.current;
    const before = editor?.getBoundingClientRect().height ?? 0;
    insertPlainText(e.clipboardData.getData('text/plain'));
    smoothPasteGrowth(editor, before);
  }

  function onEditorCopy(e: React.ClipboardEvent<HTMLDivElement>) {
    if (variableInput(e.target)) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const fragment = document.createElement('div');
    fragment.append(selection.getRangeAt(0).cloneContents());
    if (!fragment.querySelector('[data-prompt-variable]')) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', readablePromptVariables(domToText(fragment)));
  }

  function onEditorCut(e: React.ClipboardEvent<HTMLDivElement>) {
    onEditorCopy(e);
    if (!e.isDefaultPrevented()) return;
    if (typeof document.execCommand === 'function') document.execCommand('delete');
    else window.getSelection()?.getRangeAt(0).deleteContents();
    syncFromDom();
  }

  // chip hover 预览：事件委托在编辑器上，进出 [data-mention] 时开关
  function onEditorMouseOver(e: React.MouseEvent<HTMLDivElement>) {
    const span = (e.target as HTMLElement).closest?.('[data-mention]');
    if (span && editorRef.current?.contains(span)) {
      const r = span.getBoundingClientRect();
      setChipHover({ label: span.getAttribute('data-mention') ?? '', left: r.left + r.width / 2, top: r.top });
    }
  }

  function onEditorMouseOut(e: React.MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest?.('[data-mention]')) setChipHover(null);
  }

  function handleRefAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    if (isOmni) {
      // 单入口收所有类型：按 MIME 分流进各自数组并执行 9/3/3 上限，超限的不加入并在状态条说明。
      const images = [...referenceImages];
      const videos = [...referenceVideos];
      const audios = [...referenceAudios];
      let dropped = 0;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('video/')) {
          if (videoCaps?.supportsReferenceVideo && videos.length < maxRefVids) videos.push(file);
          else dropped += 1;
        } else if (file.type.startsWith('audio/')) {
          if (videoCaps?.supportsReferenceAudio && audios.length < maxRefAudios) audios.push(file);
          else dropped += 1;
        } else if (file.type.startsWith('image/')) {
          if (images.length < maxRefImgs) images.push(file);
          else dropped += 1;
        }
      }
      onReferenceImagesChange?.(images);
      onReferenceVideosChange?.(videos);
      onReferenceAudiosChange?.(audios);
      if (dropped > 0) onNotice?.(`${dropped} 个素材超出上限（图片 ${maxRefImgs} / 视频 ${maxRefVids} / 音频 ${maxRefAudios}），没有加入`);
    } else {
      const picked = Array.from(files).filter(file => !isAgent || file.type.startsWith('image/'));
      const room = Math.max(0, maxRef - referenceImages.length);
      onReferenceImagesChange?.([...referenceImages, ...picked.slice(0, room)]);
      if (picked.length > room) onNotice?.(`只加入了前 ${room} 张（上限 ${maxRef}）`);
    }
    e.target.value = '';
  }

  function handleRefRemove(file: File) {
    const idx = stackItems.findIndex(item => item.file === file);
    const item = stackItems[idx];
    if (!item) return;
    let removedNumber = idx + 1;
    if (item.kind === 'video') {
      const j = idx - referenceImages.length;
      removedNumber = j + 1;
      onReferenceVideosChange?.(referenceVideos.filter((_, i) => i !== j));
    } else if (item.kind === 'audio') {
      const j = idx - referenceImages.length - referenceVideos.length;
      removedNumber = j + 1;
      onReferenceAudiosChange?.(referenceAudios.filter((_, i) => i !== j));
    } else {
      onReferenceImagesChange?.(referenceImages.filter((_, i) => i !== idx));
    }
    // prompt 里的 @引用跟着素材删除重编号，避免「图2」悬空指错素材。
    if (text.includes('@')) setText(renumberMentions(text, MENTION_LABELS[item.kind], removedNumber));
  }

  function handleRefClearAll() {
    onReferenceImagesChange?.([]);
    onReferenceVideosChange?.([]);
    onReferenceAudiosChange?.([]);
    if (text.includes('@')) {
      setText(text.replace(/@(?:图片|图|视频|音频)\d+\s?/g, ''));
    }
    setRefDrawerOpen(false);
    setRefExpanded(false);
    setRefHovered(null);
  }

  useEffect(() => {
    if (stackItems.length === 0) setRefDrawerOpen(false);
  }, [stackItems.length]);

  // 参考素材按 File 身份取稳定 key：删中间一张时其余各张不重挂，新加的淡入放大。
  // 删除时业务引用当场移除（提交与 @ 编号立即生效），显示列表里留一份缩略图副本在原位淡出缩小。
  const fileKey = useFileKeys();
  const [leavingRefs, keepLeavingRef] = useLeavingRefs<ReferenceEntry>((entry) => {
    heldRefUrls.current.delete(entry.url);
    URL.revokeObjectURL(entry.url);
  });
  const imageInputLabels = workflowInputs?.filter(input => input.type === 'image');
  const liveRefs: ReferenceEntry[] = stackItems.map((item, i) => ({
    key: fileKey(item.file), kind: item.kind, file: item.file, thumb: thumbFor(i), url: mediaUrls[i],
    label: imageInputLabels?.[i]?.label ?? mentionItems[i]?.label, live: i,
  }));
  const displayRefs = withLeaving(liveRefs, leavingRefs.filter(entry => !stackItems.some(item => item.file === entry.snapshot.file)));
  const displayKeys = displayRefs.map(entry => entry.key);
  const arrivingRefs = useArrivingKeys(displayKeys);
  const drawerRowRef = useRef<HTMLDivElement>(null);
  useSlideOnReorder(drawerRowRef, displayKeys, refDrawerTab);
  const hoveredSlot = refHovered === null ? 0 : Math.max(0, displayRefs.findIndex(entry => entry.live === refHovered));

  function removeRef(file: File) {
    const slot = displayRefs.findIndex(entry => entry.live !== null && entry.file === file);
    if (slot < 0) return;
    const entry = displayRefs[slot];
    handleRefRemove(file);
    setRefHovered(null);
    heldRefUrls.current.add(entry.url);
    keepLeavingRef({ slot, snapshot: { ...entry, live: null } });
  }

  const showRefPanel = !isMj && (isOmni || (!isVideo && onReferenceImagesChange && maxRef > 0));
  const hoveredRefItem = refHovered !== null ? stackItems[refHovered] : null;
  const hoveredRefThumb = refHovered !== null ? thumbFor(refHovered) : null;
  const hoveredRefUrl = refHovered !== null ? mediaUrls[refHovered] : null;

  return (
    <div
      ref={shellRef}
      data-testid="studio-prompt-shell"
      data-state={collapsed ? 'collapsed' : 'expanded'}
      onClick={collapsed ? () => onExpandRequest?.() : undefined}
      onFocus={() => onShellFocusChange?.(true)}
      onBlur={(e) => {
        if (!shellRef.current?.contains(e.relatedTarget as Node)) onShellFocusChange?.(false);
      }}
      // backdrop-blur 已让外壳自成 stacking context，z-20 把它（含内部弹窗）整体抬到
      // 首页作品墙之上；全局梯度：内容卡片 auto < 外壳 20 < sticky 头 30 < lightbox/loading 50。
      // collapsed（Studio 滚动联动）收成单行条；圆角与展开态保持一致。
      // 外壳本身不做过渡（毛玻璃补间很贵）：内边距恒定，展开多出来的间距都放在下面同步收放的行里，
      // 高度走 grid-rows 0fr↔1fr，位置与大小只动 transform，统一 300ms in-out。
      className="bg-glass shell-glow rounded-xl border border-input px-4 py-2 max-w-[780px] mx-auto relative z-20 backdrop-blur-glass h-auto flex flex-col pointer-events-auto"
    >
      {showRefPanel && (
        <FileInput
          ref={refFileInputRef}
          id={refInputId}
          accept={stackAccept}
          multiple
          className="hidden"
          onChange={handleRefAdd}
        />
      )}
      {hoveredRefItem && !collapsed && (
        <div
          data-testid="reference-hover-preview"
          className="shell-glow pointer-events-none absolute -top-3 z-50 w-[168px] -translate-y-full overflow-hidden rounded-xl transition-[left] duration-200 ease-out"
          style={{
            left: `${16 + (refDrawerOpen ? hoveredSlot * (REF_W + 8) : hoveredSlot * REF_STEP)}px`,
          }}
        >
          {hoveredRefItem.kind === 'video' && hoveredRefUrl ? (
            <video src={hoveredRefUrl} autoPlay muted loop playsInline className="max-h-[220px] w-full rounded-xl object-cover" />
          ) : hoveredRefItem.kind === 'image' && hoveredRefThumb ? (
            <img src={hoveredRefThumb} alt="参考素材预览" className="max-h-[220px] w-full rounded-xl object-cover" />
          ) : (
            <div className="flex items-center gap-2 rounded-xl bg-card px-2.5 py-2 text-xs text-muted-foreground">
              <AudioIcon size="sm" aria-hidden />
              <span className="truncate">{hoveredRefItem.file.name}</span>
            </div>
          )}
        </div>
      )}
      <ShellCollapse open={!collapsed}><div className="h-1.5" /></ShellCollapse>
      <Collapse open={Boolean(showRefPanel && refDrawerOpen && !collapsed && stackItems.length > 0)}>
        <div className="pb-3">
        <div data-testid="reference-drawer" className="border-b border-border/70 pb-3">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {([
                { key: 'all', label: `全部 (${stackItems.length})`, show: true },
                { key: 'image', label: `图片 (${referenceImages.length})`, show: true },
                { key: 'video', label: `视频${referenceVideos.length ? ` (${referenceVideos.length})` : ''}`, show: isOmni || referenceVideos.length > 0 },
                { key: 'audio', label: `音频${referenceAudios.length ? ` (${referenceAudios.length})` : ''}`, show: isOmni || referenceAudios.length > 0 },
              ] as const).filter(tab => tab.show).map((tab) => (
                <Button
                  key={tab.key}
                  variant={refDrawerTab === tab.key ? 'secondary' : 'ghost'}
                  size="sm"
                  type="button"
                  onClick={() => setRefDrawerTab(tab.key)}
                  className="h-7 rounded-lg px-2.5 text-xs"
                >
                  {tab.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="reference-drawer-clear"
                onClick={handleRefClearAll}
                className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                清空全部素材
              </Button>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                data-testid="reference-drawer-collapse"
                aria-label="收起参考素材"
                onClick={() => { setRefDrawerOpen(false); setRefHovered(null); }}
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
              >
                <CollapseIcon size="sm" />
              </Button>
            </div>
          </div>
          <div ref={drawerRowRef} key={refDrawerTab} className="thin-scrollbar flex items-center gap-2 overflow-x-auto pb-1 pt-1">
            {displayRefs.map((item) => {
              if (refDrawerTab !== 'all' && item.kind !== refDrawerTab) return null;
              const i = item.live;
              const { thumb, label } = item;
              const leaving = i === null;
              return (
                <div
                  key={item.key}
                  data-ref-key={item.key}
                  data-testid={leaving ? undefined : 'reference-drawer-item'}
                  data-over-limit={overLimitImage(item) || undefined}
                  aria-hidden={leaving || undefined}
                  className={`group relative shrink-0 ${overLimitImage(item) ? 'opacity-40' : ''}`}
                  style={{ width: REF_W, height: REF_H }}
                  onMouseEnter={leaving ? undefined : () => setRefHovered(i)}
                  onMouseLeave={leaving ? undefined : () => setRefHovered(null)}
                >
                  <ReferenceItemMotion appear={arrivingRefs.has(item.key)} leaving={leaving}>
                  <div
                    role={item.kind === 'image' ? 'button' : undefined}
                    tabIndex={item.kind === 'image' && !leaving ? 0 : undefined}
                    aria-label={item.kind === 'image' ? '查看参考图大图' : undefined}
                    onClick={item.kind === 'image' && thumb ? () => setSlotLightbox(thumb) : undefined}
                    onKeyDown={item.kind === 'image' && thumb
                      ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSlotLightbox(thumb); } }
                      : undefined}
                    className={`relative h-full w-full overflow-hidden rounded-lg border-[1.5px] border-white bg-card ${
                      item.kind === 'image' ? 'cursor-zoom-in' : ''
                    }`}
                  >
                    {thumb ? (
                      <img src={thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted-foreground">
                        {item.kind === 'video' ? <VideoIcon size="lg" aria-hidden /> : <AudioIcon size="lg" aria-hidden />}
                        <span className="w-full truncate text-center text-xs">{item.file.name}</span>
                      </div>
                    )}
                    {mentionsEnabled && label && (
                      <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-scrim px-1 text-xs leading-4 text-foreground/90">
                        {label}
                      </span>
                    )}
                  </div>
                  </ReferenceItemMotion>
                  {/* 触屏没有悬停：× 常驻，热区向外扩到 28px。 */}
                  <Button
                    variant="secondary"
                    size="icon"
                    type="button"
                    aria-label={`移除参考素材 ${(i ?? 0) + 1}`}
                    disabled={leaving}
                    onClick={(e) => { e.stopPropagation(); removeRef(item.file); }}
                    className="absolute -right-1.5 -top-1.5 z-10 flex size-[18px] items-center justify-center rounded-full border border-border bg-scrim p-0 text-foreground/80 opacity-0 transition-[opacity,background-color,color] duration-150 before:absolute before:-inset-[5px] hover:bg-destructive hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <CloseIcon size="sm" />
                  </Button>
                </div>
              );
            })}
            {stackCanAdd && (
              <Label
                htmlFor={refInputId}
                className="flex shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-secondary text-muted-foreground transition-colors hover:border-input hover:text-foreground"
                style={{ width: REF_W, height: REF_H }}
              >
                <AddIcon size="md" />
                <span className="text-xs">参考内容</span>
              </Label>
            )}
          </div>
        </div>
        </div>
      </Collapse>
      {/* 第一行：版面高度恒为 60px 起，展开时由编辑器撑到 92px 以上；参考区只用 transform 落位
          （展开下移 16px 对齐 92px 行的中线，收起缩到 80%），不参与高度变化。 */}
      <div className="flex min-h-[60px] items-start gap-3.5">
        {showRefPanel && !(refDrawerOpen && !collapsed && stackItems.length > 0) && (
          <div
            data-testid="reference-images-panel"
            className={`shrink-0 relative h-[60px] overflow-visible origin-left transition-[transform,translate,scale,outline-color] duration-300 ease-in-out ${collapsed ? 'scale-80' : 'translate-y-4'} rounded-lg outline-2 outline-offset-4 ${flashArea === 'references' ? 'outline-primary' : 'outline-transparent'}`}
            style={{ width: REF_W + 14 }}
          >
            {displayRefs.length === 0 ? (
              <Label
                htmlFor={refInputId}
                aria-label={isOmni ? '添加参考内容' : '添加参考图'}
                className="absolute top-1/2 left-0 flex flex-col items-center justify-center gap-1 cursor-pointer rounded-lg border border-dashed border-border bg-secondary transition-[scale,border-color] duration-150 hover:scale-[1.02] hover:border-input"
                style={{ width: REF_W, height: REF_H, transform: 'translateY(-50%) rotate(-8deg)' }}
              >
                <AddIcon size="lg" className="text-muted-foreground" />
              </Label>
            ) : (
              <>
                {/* 三阶交互第 1/2 阶：默认堆叠；悬停时右侧层级始终高于左侧、只压一个角，hover 微上抬微放大，+ 圆钮动态形变为右侧「+ 参考内容」卡片 */}
                <div
                  className="absolute inset-y-0 left-0 overflow-visible transition-[width] duration-300 ease-in-out"
                  style={{
                    width: refExpanded
                      ? `${(displayRefs.length > 1 ? 2 : 1) * REF_STEP + REF_W + 14}px`
                      : `${REF_W + 14}px`,
                  }}
                  onMouseLeave={() => { setRefExpanded(false); setRefHovered(null); }}
                >
                  {displayRefs.map((item, slot) => {
                    // 展开时：若只有 2 张图则第 2 张直接显示；若 ≥3 张图则第 2 个槽位留给 ⤢ 展开卡，隐藏 slot >= 1。
                    // 排布按显示位置（含正在退场的副本）算，副本卸载后其余各张再顺移。
                    const hideInExpanded = refExpanded && (displayRefs.length > 2 ? slot >= 1 : slot >= 2);
                    if (hideInExpanded) return null;
                    const i = item.live;
                    const leaving = i === null;
                    const hovered = !leaving && refHovered === i;
                    const angle = refExpanded ? (slot === 0 ? -6 : 4) : collapseAngle(slot);
                    const { thumb } = item;
                    // 展开后右侧始终压左侧（哪怕 hover 左卡也不越级盖住右卡）；折叠时首图在最上
                    const zIndex = refExpanded ? 10 + slot * 10 : displayRefs.length - slot;
                    return (
                      <div
                        key={item.key}
                        data-testid={leaving ? undefined : 'reference-stack-item'}
                        data-over-limit={overLimitImage(item) || undefined}
                        aria-hidden={leaving || undefined}
                        className={`absolute top-1/2 left-0 transition-[left,transform,opacity] duration-300 ease-in-out ${overLimitImage(item) ? 'opacity-40' : ''}`}
                        style={{
                          width: REF_W,
                          height: REF_H,
                          zIndex,
                          left: refExpanded ? `${slot * REF_STEP}px` : '0px',
                          transform: `translateY(calc(-50% + ${hovered ? REF_HOVER_LIFT : 0}px)) rotate(${angle}deg) scale(${hovered ? REF_HOVER_SCALE : 1})`,
                        }}
                        onMouseEnter={leaving ? undefined : () => { if (!collapsed) { setRefExpanded(true); setRefHovered(i); } }}
                        onMouseLeave={leaving ? undefined : () => setRefHovered(null)}
                      >
                        <ReferenceItemMotion appear={arrivingRefs.has(item.key)} leaving={leaving}>
                        <div
                          role={item.kind === 'image' ? 'button' : undefined}
                          tabIndex={item.kind === 'image' && !leaving ? 0 : undefined}
                          aria-label={item.kind === 'image' ? '查看参考图大图' : undefined}
                          onClick={item.kind === 'image' && thumb ? () => setSlotLightbox(thumb) : undefined}
                          onKeyDown={item.kind === 'image' && thumb
                            ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSlotLightbox(thumb); } }
                            : undefined}
                          className={`relative w-full h-full rounded-lg overflow-hidden border-[1.5px] border-white bg-card ${
                            item.kind === 'image' ? 'cursor-zoom-in' : ''
                          }`}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted-foreground">
                              {item.kind === 'video' ? <VideoIcon size="lg" aria-hidden /> : <AudioIcon size="lg" aria-hidden />}
                              <span className="w-full truncate text-center text-xs">{item.file.name}</span>
                            </div>
                          )}
                          {mentionsEnabled && (
                            <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-scrim px-1 text-xs leading-4 text-foreground/90">
                              {item.label}
                            </span>
                          )}
                        </div>
                        </ReferenceItemMotion>
                      </div>
                    );
                  })}
                  {refHovered !== null && stackItems[refHovered] && (
                    <Button
                      variant="bare"
                      type="button"
                      aria-label={`移除参考素材 ${refHovered + 1}`}
                      onMouseEnter={() => { if (!collapsed) { setRefExpanded(true); setRefHovered(refHovered); } }}
                      onClick={(e) => { e.stopPropagation(); removeRef(stackItems[refHovered].file); }}
                      className="absolute z-50 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-scrim text-foreground/80 transition-[left,background-color,color,scale] duration-200 before:absolute before:-inset-[5px] hover:bg-destructive hover:text-foreground"
                      style={{
                        left: `${(refExpanded ? hoveredSlot * REF_STEP : 0) + REF_W - 11}px`,
                        top: `calc(50% - ${REF_H / 2 + 11}px)`,
                      }}
                    >
                      <CloseIcon size="sm" />
                    </Button>
                  )}
                  {refExpanded && displayRefs.length > 2 && (
                    <div
                      role="button"
                      tabIndex={0}
                      data-testid="reference-drawer-expand"
                      aria-label="展开全部参考素材"
                      onClick={() => { setRefDrawerOpen(true); setRefExpanded(false); setRefHovered(null); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setRefDrawerOpen(true);
                          setRefExpanded(false);
                          setRefHovered(null);
                        }
                      }}
                      className="absolute top-1/2 flex cursor-pointer items-center justify-center overflow-hidden rounded-lg border-[1.5px] border-white bg-card text-white transition-[scale] duration-150 hover:scale-[1.02]"
                      style={{
                        width: REF_W,
                        height: REF_H,
                        left: `${REF_STEP}px`,
                        zIndex: 20,
                        transform: 'translateY(-50%) rotate(4deg)',
                      }}
                    >
                      {displayRefs[1]?.thumb && (
                        <img src={displayRefs[1].thumb} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40 blur-[1px]" />
                      )}
                      <span className="relative z-10 flex h-full w-full items-center justify-center bg-scrim/70 backdrop-blur-glass">
                        <ExpandIcon size="md" />
                      </span>
                    </div>
                  )}
                  {stackCanAdd && (
                    <Label
                      data-testid="reference-stack-add"
                      htmlFor={refInputId}
                      onMouseEnter={() => { if (!collapsed) setRefExpanded(true); }}
                      className="absolute flex cursor-pointer flex-col items-center justify-center overflow-hidden border border-border bg-secondary text-muted-foreground transition-[left,top,width,height,border-radius,transform,background-color,color] duration-300 ease-in-out hover:border-input hover:bg-card hover:text-foreground"
                      style={{
                        width: refExpanded ? REF_W : 26,
                        height: refExpanded ? REF_H : 26,
                        left: refExpanded ? `${(displayRefs.length > 1 ? 2 : 1) * REF_STEP}px` : `${REF_W - 14}px`,
                        top: refExpanded ? '50%' : `calc(50% + ${REF_H / 2 - 8}px)`,
                        borderRadius: refExpanded ? '8px' : '9999px',
                        zIndex: 30,
                        transform: refExpanded ? 'translateY(-50%) rotate(-5deg)' : 'translateY(-50%) rotate(0deg)',
                      }}
                    >
                      <AddIcon size={refExpanded ? 'md' : 'sm'} className="shrink-0" />
                      <span
                        className={`overflow-hidden whitespace-nowrap text-xs transition-[max-height,margin,opacity] duration-300 ease-in-out ${
                          refExpanded ? 'mt-1 max-h-4 opacity-100' : 'mt-0 max-h-0 opacity-0'
                        }`}
                      >
                        参考内容
                      </span>
                    </Label>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {isMj && onMjRefsChange && (
          <div className={slotRowClass(collapsed, flashArea === 'references')}>
            <MjReferenceSlots
              refs={mjRefs}
              onChange={onMjRefsChange}
              version={mjParams.version}
              srefCodeActive={hasSrefCode(mjParams)}
              evolink={isEvoMj}
            />
          </div>
        )}
        {isVideo && videoMode === 'firstlast' && onVideoFramesChange && (videoCaps?.maxFrames ?? 2) > 0 && (
          <div className={slotRowClass(collapsed, flashArea === 'references')}>
            <FirstLastFrames
              frames={videoFrames}
              onChange={onVideoFramesChange}
              maxFrames={(videoCaps?.maxFrames ?? 2) >= 2 ? 2 : 1}
            />
          </div>
        )}
        {/* 编辑器高度走 grid-rows：收起时只留首行（32px 窗口裁掉其余行），整块下移 14px 落到 60px 行的中线。 */}
        <div className={`grid min-w-0 flex-1 rounded-md outline-2 outline-offset-2 transition-[grid-template-rows,translate,outline-color] duration-300 ease-in-out ${collapsed ? 'grid-rows-[0fr] translate-y-3.5' : 'grid-rows-[1fr]'} ${flashArea === 'prompt' ? 'outline-primary' : 'outline-transparent'}`}>
        <div className="min-h-8 overflow-hidden">
        <div
          ref={editorRef}
          contentEditable={!noWorkflowPrompt}
          aria-disabled={noWorkflowPrompt}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={isAgent ? "Agent 消息" : "生图 prompt"}
          aria-describedby={variableError ? variableErrorId : undefined}
          data-placeholder={isAgent ? '输入想法或上传参考，和 Agent 一起创作' : noWorkflowPrompt ? '此工作流无需提示词' : isVideo ? (mentionsEnabled && stackItems.length > 0 ? '描述画面主体、运镜与氛围，输入 @ 引用参考素材...' : '描述画面主体、运镜与氛围...') : (mentionsEnabled && stackItems.length > 0 ? '描述你想生成的画面，输入 @ 引用参考素材...' : '描述你想生成的画面...')}
          onInput={onEditorInput}
          onKeyDown={onKey}
          onKeyUp={rememberEditorRange}
          onMouseUp={rememberEditorRange}
          onBlur={rememberEditorRange}
          onPaste={onEditorPaste}
          onCopy={onEditorCopy}
          onCut={onEditorCut}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; onEditorInput(e); }}
          onMouseOver={onEditorMouseOver}
          onMouseOut={onEditorMouseOut}
          className={`${isLongPrompt && !collapsed ? 'thin-scrollbar' : 'no-scrollbar'} w-full min-h-[92px] max-h-[220px] py-1 cursor-text whitespace-pre-wrap break-words bg-transparent text-sm leading-6 text-foreground focus:outline-none rounded-md pl-2 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground ${
            collapsed ? 'overflow-hidden pr-10' : `overflow-y-auto ${onSavePromptAsset ? 'pr-10' : 'pr-2'}`
          }`}
        />
        </div>
        </div>
        <SubjectFeedback prompt={text} rows={subjects} model={model} explicit={referenceImages.length} />
        {variableError && <span id={variableErrorId} className="sr-only">{variableError}</span>}
        {onSavePromptAsset && !collapsed && text.trim() && (
          <Button variant="bare"
            type="button"
            aria-label="保存当前提示词为资产"
            onClick={onSavePromptAsset}
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <SaveAssetIcon />
          </Button>
        )}
        {/* chip hover 预览：视频静音循环播放 / 图片放大 / 音频文件卡，浮在 chip 上方 */}
        {chipHover && (() => {
          const item = mentionItems.find((m) => m.label === chipHover.label);
          if (!item) return null;
          const url = mediaUrls[item.index];
          return createPortal(
            <div
              data-testid="mention-preview"
              className="fixed z-50 pointer-events-none"
              style={{ left: chipHover.left, top: chipHover.top - 8, transform: 'translate(-50%, -100%)' }}
            >
              {item.kind === 'video' ? (
                <video src={url} autoPlay muted loop playsInline className="h-[150px] rounded-lg border border-border bg-card" />
              ) : item.kind === 'image' ? (
                <img src={url} alt="" className="h-[150px] rounded-lg border border-border object-cover" />
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground">
                  <AudioIcon aria-hidden />
                  <span className="max-w-[200px] truncate">{item.file.name}</span>
                </div>
              )}
            </div>,
            document.body,
          );
        })()}
        <ToolbarPopover
          open={mentionOpen && (mentionItems.length > 0 || subjects.length > 0)}
          onClose={() => setMentionOpen(false)}
          anchorRef={editorRef}
          direction={menuDirection}
          role="listbox"
          aria-label="引用参考素材"
          data-testid="mention-popover"
          maxHeight={280}
          className="w-[260px] max-h-[280px] overflow-y-auto rounded-xl border border-border bg-card p-1"
        >
          {!isAgent && <MentionTabs value={mentionTab} change={setMentionTab} />}
          {subjects.map(s => <Button key={s.id} role="option" aria-selected="false" variant="ghost" className="w-full justify-start"
            onMouseDown={e => e.preventDefault()} onClick={() => insertMention(subjectToken(s))}>
            {s.cover_item_id && <img src={itemThumb(s.cover_item_id)} className="size-8 rounded-md object-cover" alt="" />}
            {s.name}<span className="text-xs text-muted-foreground">@{s.handle}</span></Button>)}
          {mentionTab === 'all' && mentionsEnabled && mentionItems.map((item) => (
            <Button variant="bare"
              key={item.index}
              type="button"
              role="option"
              aria-selected="false"
              // 按下不抢编辑器焦点：插入要依赖编辑器里的光标位置（@ 触发字符所在处）
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(item.label)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-secondary/60 transition-colors"
            >
              {thumbFor(item.index) ? (
                <img src={thumbFor(item.index)!} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                  {item.kind === 'video' ? <VideoIcon size="sm" aria-hidden /> : <AudioIcon size="sm" aria-hidden />}
                </span>
              )}
              <span className="shrink-0 font-medium">{item.label}</span>
              <span className="min-w-0 truncate text-muted-foreground">{item.file.name}</span>
            </Button>
          ))}
        </ToolbarPopover>
      </div>
      {/* 控件行收放：grid-rows 0fr/1fr 让 auto 高度可动画；内容层 origin-bottom 向中下缩放并渐隐，
          中层常驻 overflow-hidden 把整个过程关在壳内部（弹窗已全部 portal 出壳，不受裁剪）。
          展开时与上一行的 12px 间距、底部多出的 8px 都在这一层里，跟着一起收。 */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${
          collapsed ? 'grid-rows-[0fr] pointer-events-none' : 'grid-rows-[1fr]'
        }`}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">
          <div
            className={`origin-bottom pt-3 pb-3 transition-[opacity,scale,translate] duration-300 ease-in-out ${
              collapsed ? 'scale-90 translate-y-2 opacity-0' : 'opacity-100'
            }`}
          >
      <div
        onMouseEnter={() => setBarHovering(true)}
        onMouseLeave={() => setBarHovering(false)}
        className="flex items-center gap-3"
      >
        {/* 控件行：单排横向滚动，超出宽度的控件向右缘渐隐（mask 逐像素淡到背景），
            悬停底栏任意处右缘浮现实心箭头胶囊（最顶层），点它或触控板横滑查看被隐控件。
            弹窗已 portal 出本容器，不受 overflow-x:auto 的纵向裁剪。 */}
        <div className="relative flex-1 min-w-0">
          <div
            ref={trackRef}
            onScroll={updateScroll}
            className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={canScrollRight ? { maskImage: trackMask, WebkitMaskImage: trackMask } : undefined}
          >
          <div ref={kindRef} data-testid="kind-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'kind'}
              aria-label="选择生成模式"
              onClick={() => setOpenPanel(openPanel === 'kind' ? null : 'kind')}
            >
              <SwapIcon swapKey={kind}>{isAgent ? <AiIcon size="sm" aria-hidden /> : isVideo ? <VideoIcon size="sm" aria-hidden /> : <ImageIcon size="sm" aria-hidden />}</SwapIcon>
              {isAgent ? 'Agent' : isVideo ? '视频' : '图片'}
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'kind'}
              onClose={() => setOpenPanel(null)}
              anchorRef={kindRef}
              direction={menuDirection}
              role="listbox"
              aria-label="生成模式列表"
              className="flex flex-col gap-2 w-[200px] rounded-xl border border-border bg-card p-2"
            >
                <div className="px-3 py-2 text-sm text-muted-foreground">生成模式</div>
                {([
                  { key: 'agent', label: 'Agent', icon: <AiIcon size="lg" aria-hidden /> },
                  { key: 'image', label: '图片', icon: <ImageIcon size="lg" aria-hidden /> },
                  { key: 'video', label: '视频', icon: <VideoIcon size="lg" aria-hidden /> },
                ] as const).map((item) => (
                  <Button variant="bare"
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={kind === item.key}
                    onClick={() => {
                      onKindChange?.(item.key);
                      setOpenPanel(null);
                    }}
                    className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    {item.icon}
                    {item.label}
                  </Button>
                ))}
            </ToolbarPopover>
          </div>

          {isAgent ? agentControls : <>
          <div ref={providerRef} data-testid="provider-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'provider'}
              aria-label="选择供应商"
              onClick={() => visibleProviders.length === 0 ? openOnboarding('model_chip') : setOpenPanel(openPanel === 'provider' ? null : 'provider')}
            >
              <ProviderBrandIcon provider={provider} size="sm" /> {providerDisplayName}
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'provider'}
              onClose={() => setOpenPanel(null)}
              anchorRef={providerRef}
              direction={menuDirection}
              role="listbox"
              aria-label="选择供应商列表"
              maxHeight={400}
              className="flex flex-col gap-2 w-[280px] max-h-[400px] overflow-y-auto no-scrollbar rounded-xl border border-border bg-card p-2"
            >
                <div className="px-3 py-2 text-sm text-muted-foreground">选择供应商</div>
                {visibleProviders.map((item) => (
                  <Button variant="bare"
                    key={item.alias}
                    type="button"
                    role="option"
                    aria-selected={item.alias === provider?.alias}
                    onClick={() => {
                      onProviderChange?.(item.alias);
                      onModelChange?.(
                        models.some(m => m.id === model) && item.models.some(m => m.id === model && visibleModel(m, item))
                          ? model! : sortModels(item.models.filter(m => visibleModel(m, item)))[0]?.id ?? '',
                      );
                      setOpenPanel(null);
                    }}
                    className="flex shrink-0 h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <ProviderBrandIcon provider={item} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{providerName(item)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{isAutoProvider(item) ? '' : `${item.alias} · `}{item.models.length} 个模型</span>
                    </span>
                  </Button>
                ))}
            </ToolbarPopover>
          </div>

          <div ref={modelRef} data-testid="model-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'model'}
              aria-label="选择模型"
              onPointerEnter={() => void prefetchModelPickerMetrics(pickerChoices, pickerParams)}
              onFocus={() => void prefetchModelPickerMetrics(pickerChoices, pickerParams)}
              onClick={() => !provider || models.length === 0 ? openOnboarding('model_chip') : setOpenPanel(openPanel === 'model' ? null : 'model')}
            >
              {selectedModel?.id.startsWith('comfyui-') ? <WorkflowIcon size="sm" aria-hidden /> : <ModelBrandIcon brand={modelBrand(selectedModel?.id ?? '')} size="sm" />} {selectedModel ? modelDisplayName(selectedModel) : models.length > 0 ? '选择模型' : '未配置模型'}
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'model'}
              onClose={() => setOpenPanel(null)}
              anchorRef={modelRef}
              direction={menuDirection}
              autoFocus
              maxHeight={400}
              className="flex w-80 flex-col rounded-xl border border-border bg-card p-2"
            >
              <ModelPickerList choices={pickerChoices} selected={`${provider?.alias}:${model}`}
                initialKind={wantedModality} sections
                params={pickerParams}
                onSelect={choice => {
                  const nextKind = modelModality(choice.model, choice.key) === 'video' ? 'video' : 'image';
                  if (nextKind !== kind) onKindChange?.(nextKind);
                  onModelChange?.(choice.model.id);
                  setOpenPanel(null);
                  modelRef.current?.querySelector('button')?.focus();
                }} />
            </ToolbarPopover>
          </div>

          {!isVideo && (
            <>
          {(caps.ratios.length > 0 || caps.showAutoSize || caps.showCustomSize || caps.qualities) && <div ref={sizeRef} data-testid="size-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'size'}
              aria-label="选择比例和分辨率"
              onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
            >
              <AspectRatioIcon size="sm" aria-hidden />
              {imageSizeSummary(sizeParams)}
              {/* 第二段没有实际参数时连分隔符一起省掉，避免按钮末尾挂一根竖线。 */}
              {sizeControlDetail && (
                <>
                  <span className="text-muted-foreground">|</span>
                  {sizeControlDetail}
                </>
              )}
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'size'}
              onClose={() => setOpenPanel(null)}
              anchorRef={sizeRef}
              direction={menuDirection}
              data-testid="size-popover"
              className="w-[320px] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-3"
            >
                <div className="space-y-4">
                  <ImageSizeFields caps={caps} model={size.modelId} baseUrl={size.baseUrl} params={sizeParams} onPatch={patch => onSizeParamsChange?.(patch)} />

                  {caps.qualities && (
                    <section className="w-[296px]">
                      <div className="py-1 px-1 text-xs text-muted-foreground">质量</div>
                      <Segmented
                        aria-label="选择质量"
                        className={`grid h-9 ${caps.qualities.length === 5 ? 'grid-cols-5' : caps.qualities.length >= 4 ? 'grid-cols-4' : 'grid-cols-3'} rounded-lg bg-popover p-0.5`}
                      >
                        {caps.qualities.map((item) => (
                          <SegmentedItem key={item} value={item} selected={quality === item}
                            onSelect={() => onQualityChange?.(item)}>
                            {QUALITY_LABELS[item]}
                          </SegmentedItem>
                        ))}
                      </Segmented>
                    </section>
                  )}

                  <GptImage26Fields caps={caps} params={sizeParams} hasReferences={referenceImages.length > 0}
                    onPatch={patch => onSizeParamsChange?.(patch)} />
                  <TransparentBackgroundField caps={caps} params={sizeParams}
                    onPatch={patch => onSizeParamsChange?.(patch)} />
                </div>
            </ToolbarPopover>
          </div>}

          {isMj && (
            <MjControls
              value={isEvoMj ? evolinkMjParams(mjParams) : mjParams}
              onChange={(patch) => onMjParamsChange?.(patch)}
              filledRefs={{
                image: mjRefs.image.length > 0,
                sref: mjRefs.sref.length > 0 || hasSrefCode(mjParams),
                cref: mjRefs.cref.length > 0,
                oref: mjRefs.oref.length > 0,
              }}
              menuDirection={menuDirection}
              evolink={isEvoMj}
            />
          )}

          <div ref={countRef} data-testid="count-control-wrap" className="relative shrink-0">
            {/* MJ 一次固定出 4 张：张数做成禁用态，说明放在提示里（禁用按钮收不到悬停，套一层 span）。 */}
            {isMj ? (
              <Hint label="Midjourney 一次出 4 张，张数不可调"><span className="inline-flex">
                <ControlButton active={false} aria-label="选择出图数量" disabled>
                  <ImagesIcon size="sm" aria-hidden /> {MJ_IMAGES_PER_TASK} 张
                </ControlButton>
              </span></Hint>
            ) : (
              <ControlButton
                active={openPanel === 'count'}
                aria-label="选择出图数量"
                disabled={fixedWorkflowSeed}
                onClick={() => setOpenPanel(openPanel === 'count' ? null : 'count')}
              >
                <ImagesIcon size="sm" aria-hidden /> {fixedWorkflowSeed ? 1 : Math.min(count, caps.maxCount ?? 4)} 张
              </ControlButton>
            )}
            <ToolbarPopover
              open={openPanel === 'count'}
              onClose={() => setOpenPanel(null)}
              anchorRef={countRef}
              direction={menuDirection}
              aria-label="选择出图数量列表"
              className="rounded-xl border border-border bg-card p-3"
            >
                <CountOptions
                  value={Math.min(count, caps.maxCount ?? 4)}
                  max={caps.maxCount}
                  onSelect={(item) => {
                    onCountChange?.(item);
                    setOpenPanel(null);
                  }}
                />
            </ToolbarPopover>
          </div>
          {workflowInputs != null && <WorkflowParameters inputs={workflowInputs} params={{ ...sizeParams, n: count }} menuDirection={menuDirection} onPatch={patch => { onSizeParamsChange?.(patch); if (patch.n != null) onCountChange?.(patch.n); }} />}
            </>
          )}
          {isVideo && videoCaps && (
            <>
              <VideoControls
                seed={videoSeed}
                onClearSeed={onClearVideoSeed}
                caps={videoCaps}
                mode={videoMode}
                duration={duration}
                resolution={videoResolution}
                ratio={videoRatio}
                quality={videoQuality}
                generateAudio={generateAudio}
                onModeChange={(m) => onVideoModeChange?.(m)}
                onDurationChange={(d) => onDurationChange?.(d)}
                onResolutionChange={(r) => onVideoResolutionChange?.(r)}
                onRatioChange={(r) => onVideoRatioChange?.(r)}
                onQualityChange={(q) => onVideoQualityChange?.(q)}
                onGenerateAudioChange={(g) => onGenerateAudioChange?.(g)}
                menuDirection={menuDirection}
              />
              <div ref={countRef} data-testid="video-count-control-wrap" className="relative shrink-0">
                <ControlButton
                  active={openPanel === 'count'}
                  aria-label="选择视频生成数量"
                  onClick={() => setOpenPanel(openPanel === 'count' ? null : 'count')}
                >
                  <ImagesIcon size="sm" aria-hidden /> {videoCount} 条
                </ControlButton>
                <ToolbarPopover
                  open={openPanel === 'count'}
                  onClose={() => setOpenPanel(null)}
                  anchorRef={countRef}
                  direction={menuDirection}
                  aria-label="选择视频生成数量列表"
                  className="rounded-xl border border-border bg-card p-3"
                >
                    <CountOptions
                      value={videoCount}
                      onSelect={(item) => {
                        onVideoCountChange?.(item);
                        setOpenPanel(null);
                      }}
                    />
                </ToolbarPopover>
              </div>
            </>
          )}
          </>}
          {onToggleAssetPanel && (
            <div className="relative shrink-0">
              <ControlButton
                active={Boolean(assetPanelOpen)}
                aria-label="打开创作资产"
                aria-expanded={Boolean(assetPanelOpen)}
                onClick={onToggleAssetPanel}
              >
                <LibraryIcon size="sm" aria-hidden /> 资产库
              </ControlButton>
            </div>
          )}
          </div>
          {/* 渐隐区拦截层：被盖住的控件不可 hover / 点击，必须先滚出来。 */}
          {canScrollRight && (
            <div aria-hidden className="absolute right-0 inset-y-0" style={{ width: scrollBlockWidth }} />
          )}
          {/* 右缘滚动箭头：实心胶囊、浮在最顶层，悬停底栏任意处即现。 */}
          <Button variant="bare"
            type="button"
            aria-label="向右滚动查看更多"
            onClick={() => trackRef.current?.scrollBy({ left: 200, behavior: 'smooth' })}
            className={`absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary text-foreground transition-opacity ${
              canScrollRight && barHovering ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            }`}
          >
            <ChevronRightIcon size="lg" aria-hidden />
          </Button>
        </div>
        {/* pr-12 给提交按钮让位：按钮已改为绝对定位锚在壳右下角（见 shell 末尾），不再占这一行的 flex 位 */}
        <div className="flex items-center gap-3 shrink-0 pr-12">
          {estimateLabel && !workflowReferenceProblem && !lastFrameOnlyBlocked && !comfyStopped && (
            <span data-testid="studio-estimate" className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{estimateLabel}</span>
          )}
          {workflowReferenceProblem && <span role="status" className="text-xs text-muted-foreground">{workflowReferenceProblem}</span>}
          {!workflowReferenceProblem && !lastFrameOnlyBlocked && comfyStopped && (
            <Hint label="点击重新检查连接">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="comfy-stopped-hint"
                onClick={recheckComfy}
                className="h-auto gap-1.5 px-1.5 py-0.5 font-normal text-[color:var(--status-failed)] hover:text-[color:var(--status-failed)]"
              >
                <span aria-hidden className="size-1.5 rounded-full bg-current" />
                ComfyUI 未启动
              </Button>
            </Hint>
          )}
          {lastFrameOnlyBlocked && (
            <span
              data-testid="frame-block-hint"
              className="inline-flex items-center gap-1 text-xs text-destructive"
            >
              <VideoIcon size="sm" aria-hidden />
              需先放首帧
            </span>
          )}
        </div>
      </div>
          </div>
        </div>
      </div>
      {/* 提交按钮：唯一一颗，锚定壳右下角，固定 40px。收起只在外层做 transform（缩到 80%、上移 2px
          落到单行条中线），不改尺寸与位置；缩放放在外层，按下反馈的 scale 不会和它打架。 */}
      <div className={`absolute bottom-4 right-4 origin-center transition-transform duration-300 ease-in-out ${collapsed ? '-translate-y-0.5 scale-80' : ''}`}>
      <Hint label={isAgent ? (onStop ? '停止' : '发送 ↵') : workflowReferenceProblem ?? (lastFrameOnlyBlocked ? 'Seedance 不支持只给尾帧：请先放首帧，或首尾都放' : '生成 ⌘↵ / Ctrl+↵')}><Button variant="bare"
        ref={submitButtonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); if (onStop) onStop(); else submit(); }}
        disabled={!onStop && !canSubmit}
        aria-label={isAgent ? (onStop ? "停止" : "发送") : "生成"}
        className="inline-flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background"
      >
        <SwapIcon swapKey={ActionIcon === StopIcon ? 'stop' : 'send'}><ActionIcon size="lg" aria-hidden /></SwapIcon>
      </Button></Hint>
      </div>
      {slotLightbox && <Lightbox src={slotLightbox} onClose={() => setSlotLightbox(null)} />}
    </div>
  );
}

/** 粘贴大段文字时编辑器一次长高好几行：用 150ms 补上这段高度，逐字输入的单行增高不经过这里，照旧跟手。
 *  外壳贴底悬浮，高度从上沿长出，底边始终不动。 */
const PASTE_GROWTH_MIN_PX = 24;
function smoothPasteGrowth(editor: HTMLElement | null, before: number) {
  if (!editor || !motionAvailable() || prefersReducedMotion()) return;
  const after = editor.getBoundingClientRect().height;
  if (Math.abs(after - before) < PASTE_GROWTH_MIN_PX) return;
  clearOnFinish(
    animate(editor, { height: [`${before}px`, `${after}px`] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }),
    editor,
    ['height'],
  );
}

/** 输入壳里随收放出现/消失的一段：grid-rows 0fr↔1fr，与壳内其他收放同一时长与曲线。 */
function ShellCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** MJ 参考槽、首尾帧：版面固定 60px 高，展开下移 16px 对齐 92px 行的中线，收起缩到 80%，只动 transform。 */
function slotRowClass(collapsed: boolean, flash: boolean) {
  return `flex h-[60px] shrink-0 items-center origin-left rounded-lg outline-2 outline-offset-4 transition-[transform,translate,scale,outline-color] duration-300 ease-in-out ${collapsed ? 'scale-80' : 'translate-y-4'} ${flash ? 'outline-primary' : 'outline-transparent'}`;
}

/** 数量弹窗的 1-4 选项（图片张数 / 视频条数共用同一配方）：与质量等单选同一个分段控件，选中底色滑到新位置。 */
function CountOptions({ value, onSelect, max = 4 }: { value: number; max?: number; onSelect: (n: number) => void }) {
  return (
    <Segmented aria-label="数量" className="h-9 auto-cols-[36px] grid-flow-col">
      {[1, 2, 3, 4].filter(item => item <= max).map((item) => (
        <SegmentedItem key={item} value={String(item)} selected={value === item} onSelect={() => onSelect(item)}
          className="font-medium tabular-nums">
          {item}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}
