import { type ButtonHTMLAttributes, type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Box, ChevronRight, Coins, Film, ImageIcon, Images, Music, Plus, Square, Building2, Link2, Video, X } from 'lucide-react';
import { modelModality, type KeyView } from '@/api/keys';
import { computeStudioPixelSize, normalizeStudioPixelSizeForModel } from '@/lib/studioSize';
import { providerLabel } from '@/lib/providerLabels';
import { maxReferenceImages } from '@/lib/referenceLimits';
import { imageControlCaps, QUALITY_LABELS, type Quality } from '@/lib/imageControlCaps';
import { estimateCostYuan, isHkAggregator } from '@/lib/creditCost';
import { captureVideoFrame } from '@/lib/videoFrame';
import { VideoControls } from './VideoControls';
import {
  FirstLastFrames,
  MAX_REF_AUDIOS,
  MAX_REF_IMAGES,
  MAX_REF_VIDEOS,
  type FrameSlots,
} from './VideoReferenceAssets';
import { RatioIcon } from './RatioIcon';
import { ToolbarPopover } from './ToolbarPopover';
import type { VideoControlCaps, VideoMode, VideoQuality } from '@/lib/videoControlCaps';
import type { JobKind } from '@/schema/jobs';

interface Props {
  onSubmit: (prompt: string) => void | Promise<void>;
  disabled?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  providers?: KeyView[];
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  count?: number;
  onProviderChange?: (alias: string) => void;
  onModelChange?: (model: string) => void;
  onRatioChange?: (ratio: string) => void;
  onResolutionChange?: (resolution: '2K' | '4K') => void;
  onCountChange?: (count: number) => void;
  onCustomSizeChange?: (w: number, h: number) => void;
  quality?: Quality;
  onQualityChange?: (quality: Quality) => void;
  /** When set, overrides localW/localH after the ratio/resolution effect; keyed to ensure re-runs. */
  sizeOverride?: { key: number; w: number; h: number };
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
  kind?: JobKind;
  onKindChange?: (kind: JobKind) => void;
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
  onGenerateAudioChange?: (generateAudio: boolean) => void;
  referenceVideos?: File[];
  referenceAudios?: File[];
  onReferenceVideosChange?: (files: File[]) => void;
  onReferenceAudiosChange?: (files: File[]) => void;
  videoFrames?: FrameSlots;
  onVideoFramesChange?: (frames: FrameSlots) => void;
}

const SIDE_RATIOS = ['4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

const REF_W = 56.5;
const REF_H = 70;
// 折叠堆叠时按 index 取的旋转角度（循环），制造层次让用户看到下面的图
const COLLAPSE_ANGLES = [8, -4, 22, -8, 8, -4];
const collapseAngle = (i: number) => COLLAPSE_ANGLES[i % COLLAPSE_ANGLES.length];
// 展开时两两对称交替：8, -5, 8, -5...
const expandAngle = (i: number) => (i % 2 === 0 ? 8 : -5);

function providerName(provider?: KeyView) {
  if (!provider) return '未配置厂商';
  return providerLabel(provider.provider, provider.alias);
}

/** @引用的素材类目标签。契约（seedance 官方 / happyhorse [Image N]）按「类型 + 序号」指代素材。 */
const MENTION_LABELS = { image: '图', video: '视频', audio: '音频' } as const;

/** 删除素材后重写 prompt 里的 @引用：被删序号的引用移除，更大序号依次前移。 */
export function renumberMentions(input: string, label: string, removed: number): string {
  return input.replace(new RegExp(`@${label}(\\d+)`, 'g'), (match, num: string) => {
    const n = parseInt(num, 10);
    if (n === removed) return '';
    if (n > removed) return `@${label}${n - 1}`;
    return match;
  });
}

/** 提交序列化：@图1 → 图1。API 契约靠序号自然语言绑定素材，@ 只是输入框里的交互糖。 */
export function serializeMentions(prompt: string): string {
  return prompt.replace(/@(图|视频|音频)(\d+)/g, '$1$2');
}

// ---- @引用 chip 化：编辑器 DOM 与 prompt 字符串互转 ----
// 编辑器是 contentEditable（chip 是 contentEditable=false 的原子 span，整删 / hover 预览），
// 但状态层仍是带 @图N 字面量的纯字符串——重编号 / 序列化逻辑因此完全不变。

const MENTION_TOKEN_RE = /@(图|视频|音频)(\d+)/g;

type ChipMeta = { kind: 'image' | 'video' | 'audio'; thumb: string | null };

/** lucide Film / Music 的内联 SVG：chip 走命令式 DOM 构建，用不了 React 图标组件。 */
const CHIP_ICON_SVG: Record<'video' | 'audio', string> = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
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
  providers = [],
  providerAlias,
  model,
  ratio = '1:1',
  resolution = '2K',
  count = 1,
  onProviderChange,
  onModelChange,
  onRatioChange,
  onResolutionChange,
  onCountChange,
  onCustomSizeChange,
  quality = 'medium' as Quality,
  onQualityChange,
  sizeOverride,
  menuDirection = 'up',
  collapsed = false,
  onExpandRequest,
  onShellFocusChange,
  referenceImages = [],
  onReferenceImagesChange,
  kind = 'image',
  onKindChange,
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
  referenceVideos = [],
  referenceAudios = [],
  onReferenceVideosChange,
  onReferenceAudiosChange,
  videoFrames = { first: null, last: null },
  onVideoFramesChange,
}: Props) {
  const isVideo = kind === 'video';
  const [internalText, setInternalText] = useState('');
  const text = value ?? internalText;
  const setText = onValueChange ?? setInternalText;
  const [openPanel, setOpenPanel] = useState<'kind' | 'provider' | 'model' | 'size' | 'count' | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // 控件 chip 外壳锚点：弹窗 portal 出横滚容器后靠这些 ref 定位。
  const kindRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  // 控件行横滚：track 容器 + 是否还能右滚 + 底栏 hover（决定右缘箭头是否浮现）。
  const trackRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [barHovering, setBarHovering] = useState(false);
  const [refExpanded, setRefExpanded] = useState(false);
  const [refHovered, setRefHovered] = useState<number | null>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const refInputId = useId();
  // @引用编辑器：contentEditable DOM 是输入现场，text 字符串是状态层；
  // lastSynced 区分「用户输入回流」与「外部改写」——只有外部改写才重建 DOM。
  const editorRef = useRef<HTMLDivElement>(null);
  const lastSynced = useRef<string | null>(null);
  const composing = useRef(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  // chip hover 预览：标签 + fixed 锚点坐标（portal 到 body，浮在参考内容上方）
  const [chipHover, setChipHover] = useState<{ label: string; left: number; top: number } | null>(null);
  // 参考素材瞬时提示（超限被忽略 / 已达上限），数秒自动消失。
  const [refHint, setRefHint] = useState<string | null>(null);
  const refHintTimer = useRef<number | undefined>(undefined);
  const showRefHint = useCallback((msg: string) => {
    setRefHint(msg);
    window.clearTimeout(refHintTimer.current);
    refHintTimer.current = window.setTimeout(() => setRefHint(null), 5000);
  }, []);
  useEffect(() => () => window.clearTimeout(refHintTimer.current), []);
  const isOmni = isVideo && videoMode === 'omni' && Boolean(videoCaps);
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
  useEffect(() => () => mediaUrls.forEach((u) => URL.revokeObjectURL(u)), [mediaUrls]);
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
  // @引用只属于视频「全能参考」(omni)：图片生成的参考图是朴素图生图，不走 @chip/编号/扇形倾斜。
  // 用 ref 让 renderDom（[] 依赖、命令式构建）能读到最新模式而不必进依赖数组。
  const isOmniRef = useRef(isOmni);
  isOmniRef.current = isOmni;

  /** prompt 字符串 → 编辑器 DOM：@图N 字面量渲染成原子 chip。仅外部改写时调用。 */
  const renderDom = useCallback((value: string) => {
    const root = editorRef.current;
    if (!root) return;
    // 非 omni（图片 / 视频首尾帧）：prompt 是纯文本，@图N 不渲染成 chip。
    if (!isOmniRef.current) { root.textContent = value; return; }
    root.textContent = '';
    let last = 0;
    for (const m of value.matchAll(MENTION_TOKEN_RE)) {
      const idx = m.index ?? 0;
      if (idx > last) root.appendChild(document.createTextNode(value.slice(last, idx)));
      const label = `${m[1]}${m[2]}`;
      root.appendChild(buildChipEl(label, chipMetaRef.current.get(label)));
      last = idx + m[0].length;
    }
    if (last < value.length) root.appendChild(document.createTextNode(value.slice(last)));
  }, []);

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
    if (text === lastSynced.current) return;
    renderDom(text);
    lastSynced.current = text;
    const root = editorRef.current;
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
  }, [text, renderDom]);

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
    if (!isOmni || stackItems.length === 0) {
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
    setMentionOpen(open);
  }, [isOmni, stackItems.length]);

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

  function insertMention(label: string) {
    const root = editorRef.current;
    if (!root) return;
    // 先捕获 range 再 focus：focus() 可能把 selection 重置到编辑器起点（jsdom 实测会）
    const sel = window.getSelection();
    let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (range && !root.contains(range.startContainer)) range = null;
    const chip = buildChipEl(label, chipMetaRef.current.get(label));
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
  // 厂商/模型列表按当前生成类型过滤：模型级 modality 标注优先，未标注按 key 级 modalities 兜底。
  const wantedModality = isVideo ? 'video' : 'image';
  const visibleProviders = providers.filter(
    (p) => (p.models ?? []).some((m) => modelModality(m, p) === wantedModality),
  );
  const provider = visibleProviders.find((item) => item.alias === providerAlias) ?? visibleProviders[0];
  const providerDisplayName = providerName(provider);
  const models = (provider?.models ?? []).filter((m) => modelModality(m, provider) === wantedModality);
  const selectedModel = models.find((item) => item.id === model) ?? models[0];
  const initSize = computeStudioPixelSize(ratio, resolution, provider?.provider);
  const [localW, setLocalW] = useState(initSize.w);
  const [localH, setLocalH] = useState(initSize.h);
  const [sizeLocked, setSizeLocked] = useState(true);
  const caps = imageControlCaps(selectedModel?.id);
  const maxRef = maxReferenceImages(provider?.provider, selectedModel?.id);
  // omni 参考上限：按族覆盖（happyhorse video-edit = 5 图 + 1 视频），缺省 9/3/3。
  const maxRefImgs = videoCaps?.maxRefImages ?? MAX_REF_IMAGES;
  const maxRefVids = videoCaps?.maxRefVideos ?? MAX_REF_VIDEOS;
  const stackAccept = isOmni
    ? ['image/*', videoCaps?.supportsReferenceVideo && 'video/*', videoCaps?.supportsReferenceAudio && 'audio/*']
        .filter(Boolean)
        .join(',')
    : 'image/*';
  const stackCanAdd = isOmni
    ? referenceImages.length < maxRefImgs ||
      (Boolean(videoCaps?.supportsReferenceVideo) && referenceVideos.length < maxRefVids) ||
      (Boolean(videoCaps?.supportsReferenceAudio) && referenceAudios.length < MAX_REF_AUDIOS)
    : referenceImages.length < maxRef;
  // Seedance（火山 Ark）不支持只给尾帧：last_frame 必须配 first_frame。只填尾帧槽时在客户端
  // 拦下并禁用生成，不浪费一轮注定被上游拒的 API 往返（其余族 / 模式 / 再次生成路径不受影响）。
  const lastFrameOnlyBlocked =
    isVideo &&
    videoMode === 'firstlast' &&
    videoCaps?.family === 'seedance' &&
    (videoCaps?.maxFrames ?? 0) >= 2 &&
    !videoFrames?.first &&
    Boolean(videoFrames?.last);
  const canSubmit =
    Boolean(provider && selectedModel && text.trim() && !disabled) && !lastFrameOnlyBlocked;
  // 消耗提示只对 OpenAI-HK 聚合商显示（人民币，无单位）；未定价的模型/档位返回 null 即隐藏。
  const costYuan = isHkAggregator(provider?.base_url)
    ? estimateCostYuan({ model: selectedModel?.id, quality, n: isVideo ? videoCount : count })
    : null;
  const minPx = 1;
  // 控件行右缘渐隐 + 箭头几何：悬停时为箭头让出 36px 槽位，渐隐带 40px 落在箭头左侧。
  const SCROLL_ARROW = 36;
  const SCROLL_FADE = 40;
  const scrollReserve = barHovering ? SCROLL_ARROW : 0;
  const scrollBlockWidth = scrollReserve + SCROLL_FADE;
  const trackMask =
    `linear-gradient(to right, black calc(100% - ${scrollBlockWidth}px), transparent calc(100% - ${scrollReserve}px))`;

  useEffect(() => {
    const { w, h } = computeStudioPixelSize(ratio, resolution, provider?.provider);
    const normalized = normalizeStudioPixelSizeForModel({ w, h }, provider?.provider, selectedModel?.id);
    setLocalW(normalized.w);
    setLocalH(normalized.h);
    onCustomSizeChange?.(normalized.w, normalized.h);
  }, [ratio, resolution, provider?.provider, onCustomSizeChange]);

  // Runs after the ratio/resolution effect so it wins — used by reEdit to restore custom sizes.
  useEffect(() => {
    if (!sizeOverride) return;
    setLocalW(sizeOverride.w);
    setLocalH(sizeOverride.h);
    onCustomSizeChange?.(sizeOverride.w, sizeOverride.h);
  }, [sizeOverride, onCustomSizeChange]);

  const submit = useCallback(() => {
    // @图1 → 图1：API 按序号自然语言绑定素材，@ 不出现在最终 prompt 里。
    const trimmed = serializeMentions(text).trim();
    if (!trimmed || disabled || !provider || !selectedModel || lastFrameOnlyBlocked) return;
    onSubmit(trimmed);
  }, [text, disabled, provider, selectedModel, onSubmit, lastFrameOnlyBlocked]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && mentionOpen) {
      e.preventDefault();
      setMentionOpen(false);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Enter') {
      // contentEditable 原生 Enter 会包 <div>；统一改插 '\n'（编辑器 pre-wrap 渲染换行）
      e.preventDefault();
      insertPlainText('\n');
    }
  };

  function onEditorInput() {
    if (composing.current) return; // 中文输入法组合期不回流，compositionend 一次性同步
    syncFromDom();
    updateMentionMenu();
  }

  function onEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    insertPlainText(e.clipboardData.getData('text/plain'));
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
      // 单入口收所有类型：按 MIME 分流进各自数组并执行 9/3/3 上限；超限不再静默丢弃，按类目提示。
      const images = [...referenceImages];
      const videos = [...referenceVideos];
      const audios = [...referenceAudios];
      const dropped = { image: 0, video: 0, audio: 0 };
      for (const file of Array.from(files)) {
        if (file.type.startsWith('video/')) {
          if (videoCaps?.supportsReferenceVideo && videos.length < maxRefVids) videos.push(file);
          else dropped.video++;
        } else if (file.type.startsWith('audio/')) {
          if (videoCaps?.supportsReferenceAudio && audios.length < MAX_REF_AUDIOS) audios.push(file);
          else dropped.audio++;
        } else if (file.type.startsWith('image/')) {
          if (images.length < maxRefImgs) images.push(file);
          else dropped.image++;
        }
      }
      onReferenceImagesChange?.(images);
      onReferenceVideosChange?.(videos);
      onReferenceAudiosChange?.(audios);
      const parts: string[] = [];
      if (dropped.image) parts.push(`参考图最多 ${maxRefImgs} 张`);
      if (dropped.video) parts.push(videoCaps?.supportsReferenceVideo ? `参考视频最多 ${maxRefVids} 个` : '当前模型不支持参考视频');
      if (dropped.audio) parts.push(videoCaps?.supportsReferenceAudio ? `参考音频最多 ${MAX_REF_AUDIOS} 段` : '当前模型不支持参考音频');
      const droppedTotal = dropped.image + dropped.video + dropped.audio;
      if (parts.length) showRefHint(`${parts.join('，')}，已忽略 ${droppedTotal} 个文件`);
    } else {
      const total = referenceImages.length + files.length;
      if (total > maxRef) showRefHint(`参考图最多 ${maxRef} 张，已忽略 ${total - maxRef} 个文件`);
      onReferenceImagesChange?.([...referenceImages, ...Array.from(files)].slice(0, maxRef));
    }
    e.target.value = '';
  }

  function handleRefRemove(idx: number) {
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

  function handleRatioSelect(newRatio: string) {
    onRatioChange?.(newRatio);
    const { w, h } = computeStudioPixelSize(newRatio, resolution, provider?.provider);
    const normalized = normalizeStudioPixelSizeForModel({ w, h }, provider?.provider, selectedModel?.id);
    setLocalW(normalized.w);
    setLocalH(normalized.h);
    onCustomSizeChange?.(normalized.w, normalized.h);
  }

  function handleResolutionSelect(newResolution: '2K' | '4K') {
    onResolutionChange?.(newResolution);
    const { w, h } = computeStudioPixelSize(ratio, newResolution, provider?.provider);
    const normalized = normalizeStudioPixelSizeForModel({ w, h }, provider?.provider, selectedModel?.id);
    setLocalW(normalized.w);
    setLocalH(normalized.h);
    onCustomSizeChange?.(normalized.w, normalized.h);
  }

  function handleWChange(raw: string) {
    const newW = Math.max(minPx, parseInt(raw, 10) || minPx);
    setLocalW(newW);
    if (sizeLocked) {
      const [a, b] = ratio.split(':').map(Number);
      const newH = a > 0 ? Math.max(minPx, Math.round((newW * b) / a)) : localH;
      const normalized = normalizeStudioPixelSizeForModel({ w: newW, h: newH }, provider?.provider, selectedModel?.id);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    } else {
      const normalized = normalizeStudioPixelSizeForModel({ w: newW, h: localH }, provider?.provider, selectedModel?.id);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    }
  }

  function handleHChange(raw: string) {
    const newH = Math.max(minPx, parseInt(raw, 10) || minPx);
    setLocalH(newH);
    if (sizeLocked) {
      const [a, b] = ratio.split(':').map(Number);
      const newW = b > 0 ? Math.max(minPx, Math.round((newH * a) / b)) : localW;
      const normalized = normalizeStudioPixelSizeForModel({ w: newW, h: newH }, provider?.provider, selectedModel?.id);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    } else {
      const normalized = normalizeStudioPixelSizeForModel({ w: localW, h: newH }, provider?.provider, selectedModel?.id);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    }
  }

  function handleToggleLock() {
    const next = !sizeLocked;
    setSizeLocked(next);
    if (next) {
      const { w, h } = computeStudioPixelSize(ratio, resolution, provider?.provider);
      const normalized = normalizeStudioPixelSizeForModel({ w, h }, provider?.provider, selectedModel?.id);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    }
  }

  return (
    <div
      ref={shellRef}
      data-testid="studio-prompt-shell"
      onClick={collapsed ? () => onExpandRequest?.() : undefined}
      onFocus={() => onShellFocusChange?.(true)}
      onBlur={(e) => {
        if (!shellRef.current?.contains(e.relatedTarget as Node)) onShellFocusChange?.(false);
      }}
      // backdrop-blur 已让外壳自成 stacking context，z-20 把它（含内部弹窗）整体抬到
      // 首页作品墙之上；全局梯度：内容卡片 auto < 外壳 20 < sticky 头 30 < lightbox/loading 50。
      // collapsed（Studio 滚动联动）收成单行条；圆角与展开态保持一致。
      className={`bg-glass shell-glow rounded-xl border border-input px-4 max-w-[780px] mx-auto relative z-20 backdrop-blur-glass h-auto flex flex-col pointer-events-auto transition-all duration-300 ${
        collapsed ? 'pt-2 pb-2 gap-0 min-h-0' : 'pt-[14px] pb-4 gap-3 min-h-[174px]'
      }`}
    >
      <div className={`flex min-h-0 gap-2 transition-[height] duration-300 ${collapsed ? 'h-[60px]' : 'h-[92px]'}`}>
        {(isOmni || (!isVideo && onReferenceImagesChange)) && (
          <div
            data-testid="reference-images-panel"
            className={`shrink-0 self-stretch relative overflow-visible transition-transform duration-300 origin-left ${collapsed ? 'scale-80' : ''}`}
            style={{ width: REF_W + 14 }}
          >
            <input
              ref={refFileInputRef}
              id={refInputId}
              type="file"
              accept={stackAccept}
              multiple
              className="hidden"
              onChange={handleRefAdd}
            />

            {stackItems.length === 0 ? (
              <label
                htmlFor={refInputId}
                aria-label={isOmni ? '添加参考内容' : '添加参考图'}
                className="absolute top-1/2 left-0 flex flex-col items-center justify-center gap-1 cursor-pointer rounded-lg border border-dashed border-border bg-secondary transition-all duration-200 hover:-translate-y-1 hover:brightness-110 hover:border-input"
                style={{ width: REF_W, height: REF_H, transform: 'translateY(-50%) rotate(-8deg)' }}
              >
                <Plus size={18} className="text-muted-foreground" />
                {isOmni && <span className="text-xs leading-none text-muted-foreground">参考内容</span>}
              </label>
            ) : (
              <>
                {/* hover 区域覆盖参考图 + 添加按钮：展开只由参考图触发，移动到添加按钮上保持展开，离开整个区域才收起 */}
                <div
                  className="absolute inset-y-0 left-0 overflow-visible"
                  style={{
                    width: refExpanded
                      ? `${(stackItems.length - 1) * REF_W + REF_W + 12}px`
                      : `${REF_W + 12}px`,
                    transition: 'width 300ms ease',
                  }}
                  onMouseLeave={() => { setRefExpanded(false); setRefHovered(null); }}
                >
                  {stackItems.map((item, i) => {
                    const hovered = refHovered === i;
                    const angle = isOmni ? (refExpanded ? expandAngle(i) : collapseAngle(i)) : 0;
                    return (
                      <div
                        key={i}
                        className="absolute top-1/2 left-0"
                        style={{
                          width: REF_W,
                          height: REF_H,
                          // 展开后右侧压左侧；折叠时保持左侧（首图）在最上
                          zIndex: hovered ? 40 : (refExpanded ? i : stackItems.length - i),
                          left: refExpanded ? `${i * REF_W}px` : '0px',
                          transform: `translateY(-50%) rotate(${angle}deg)`,
                          transition: 'left 300ms ease, transform 300ms ease',
                        }}
                        onMouseEnter={() => { setRefExpanded(true); setRefHovered(i); }}
                        onMouseLeave={() => setRefHovered(null)}
                      >
                        <div className="relative w-full h-full rounded-lg overflow-hidden border-[1.5px] border-white bg-card">
                          {thumbFor(i) ? (
                            <img src={thumbFor(i)!} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted-foreground">
                              {item.kind === 'video' ? <Film size={18} aria-hidden /> : <Music size={18} aria-hidden />}
                              <span className="w-full truncate text-center text-xs">{item.file.name}</span>
                            </div>
                          )}
                          {/* @引用编号徽标：仅 omni 全能参考需要（图片图生图不走 @引用）。 */}
                          {isOmni && (
                            <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-scrim px-1 text-xs leading-4 text-foreground/90">
                              {mentionItems[i]?.label}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleRefRemove(i); }}
                          className="absolute -top-1.5 -right-1.5 z-10 w-[18px] h-[18px] flex items-center justify-center rounded-full bg-scrim backdrop-blur-glass border border-border text-foreground/80 hover:bg-destructive hover:text-foreground transition-colors"
                          style={{
                            zIndex: 50,
                            opacity: hovered ? 1 : 0,
                            pointerEvents: hovered ? 'auto' : 'none',
                          }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    );
                  })}
                  <label
                    htmlFor={stackCanAdd ? refInputId : undefined}
                    aria-disabled={!stackCanAdd}
                    onClick={stackCanAdd ? undefined : (e) => {
                      e.preventDefault();
                      // 已达上限的入口置灰但保持可点 → 点击解释原因（pointer-events-none 会吞掉 title）。
                      showRefHint(isOmni
                        ? `参考素材已达上限，已忽略新文件（图 ${maxRefImgs}${videoCaps?.supportsReferenceVideo ? ` / 视频 ${maxRefVids}` : ''}${videoCaps?.supportsReferenceAudio ? ` / 音频 ${MAX_REF_AUDIOS}` : ''}）`
                        : `参考图最多 ${maxRef} 张，删除后才能继续添加`);
                    }}
                    className={`absolute flex items-center justify-center rounded-full border-[0.5px] border-border bg-secondary transition-colors ${
                      stackCanAdd
                        ? 'cursor-pointer text-muted-foreground hover:text-foreground hover:border-input hover:bg-card'
                        : 'cursor-not-allowed text-muted-foreground opacity-40'
                    }`}
                    style={{
                      width: 28,
                      height: 28,
                      zIndex: 45,
                      top: '50%',
                      marginTop: 15,
                      left: `${(refExpanded ? (stackItems.length - 1) * REF_W : 0) + REF_W - 20}px`,
                      transform: `rotate(${isOmni ? (refExpanded ? expandAngle(stackItems.length - 1) : collapseAngle(stackItems.length - 1)) : 0}deg)`,
                      transition: 'left 300ms ease, transform 300ms ease',
                    }}
                  >
                    <Plus size={14} />
                  </label>
                </div>
              </>
            )}
          </div>
        )}
        {isVideo && videoMode === 'firstlast' && onVideoFramesChange && (videoCaps?.maxFrames ?? 2) > 0 && (
          <div className={`self-center shrink-0 transition-transform duration-300 origin-left ${collapsed ? 'scale-80' : ''}`}>
            <FirstLastFrames
              frames={videoFrames}
              onChange={onVideoFramesChange}
              maxFrames={(videoCaps?.maxFrames ?? 2) >= 2 ? 2 : 1}
            />
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="生图 prompt"
          data-placeholder={isOmni && stackItems.length > 0 ? '开始一段灵感对话，输入 @ 引用参考素材...' : '开始一段灵感对话...'}
          onInput={onEditorInput}
          onKeyDown={onKey}
          onPaste={onEditorPaste}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; onEditorInput(); }}
          onMouseOver={onEditorMouseOver}
          onMouseOut={onEditorMouseOut}
          className={`flex-1 min-h-0 w-full cursor-text overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-sm text-foreground focus:outline-none rounded-md pl-2 transition-[height,padding] duration-300 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground ${
            collapsed ? 'h-6 self-center overflow-hidden pr-10' : 'h-full pr-2'
          }`}
        />
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
                  <Music size={16} aria-hidden />
                  <span className="max-w-[200px] truncate">{item.file.name}</span>
                </div>
              )}
            </div>,
            document.body,
          );
        })()}
        <ToolbarPopover
          open={mentionOpen && mentionItems.length > 0}
          onClose={() => setMentionOpen(false)}
          anchorRef={editorRef}
          direction={menuDirection}
          role="listbox"
          aria-label="引用参考素材"
          data-testid="mention-popover"
          className="w-[260px] max-h-[280px] overflow-y-auto rounded-xl border border-border bg-card p-1"
        >
          {mentionItems.map((item) => (
            <button
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
                  {item.kind === 'video' ? <Film size={14} aria-hidden /> : <Music size={14} aria-hidden />}
                </span>
              )}
              <span className="shrink-0 font-medium">{item.label}</span>
              <span className="min-w-0 truncate text-muted-foreground">{item.file.name}</span>
            </button>
          ))}
        </ToolbarPopover>
      </div>
      {/* 控件行收放：grid-rows 0fr/1fr 让 auto 高度可动画；内容层 origin-bottom 向中下缩放 +
          blur 渐隐，中层常驻 overflow-hidden 把整个过程关在壳内部（弹窗已全部 portal 出壳，不受裁剪）。 */}
      <div
        className={`grid transition-all duration-300 ${
          collapsed ? 'grid-rows-[0fr] pointer-events-none' : 'grid-rows-[1fr]'
        }`}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">
          <div
            className={`origin-bottom transition-all duration-300 ${
              collapsed ? 'scale-90 translate-y-2 opacity-0 blur-[6px]' : 'scale-100 translate-y-0 opacity-100 blur-none'
            }`}
          >
      {/* 参考素材瞬时提示（超限被忽略 / 已达上限）。本地视频已由后端经 OSS 中转成直链，无需常驻警示。 */}
      {refHint && (
        <div role="status" className="pb-1.5 text-xs text-muted-foreground">
          {refHint}
        </div>
      )}
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
              {isVideo ? <Video size={14} aria-hidden /> : <ImageIcon size={14} aria-hidden />}
              {isVideo ? '视频生成' : '图片生成'}
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
                  { key: 'image', label: '图片生成', icon: <ImageIcon size={18} aria-hidden /> },
                  { key: 'video', label: '视频生成', icon: <Video size={18} aria-hidden /> },
                ] as const).map((item) => (
                  <button
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
                  </button>
                ))}
            </ToolbarPopover>
          </div>

          <div ref={providerRef} data-testid="provider-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'provider'}
              aria-label="选择厂商"
              onClick={() => setOpenPanel(openPanel === 'provider' ? null : 'provider')}
              disabled={visibleProviders.length === 0}
            >
              <Building2 size={14} aria-hidden /> {providerDisplayName}
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'provider'}
              onClose={() => setOpenPanel(null)}
              anchorRef={providerRef}
              direction={menuDirection}
              role="listbox"
              aria-label="选择厂商列表"
              className="flex flex-col gap-2 w-[280px] max-h-[400px] overflow-y-auto no-scrollbar rounded-xl border border-border bg-card p-2"
            >
                <div className="px-3 py-2 text-sm text-muted-foreground">选择厂商</div>
                {visibleProviders.map((item) => (
                  <button
                    key={item.alias}
                    type="button"
                    role="option"
                    aria-selected={item.alias === provider?.alias}
                    onClick={() => {
                      onProviderChange?.(item.alias);
                      onModelChange?.(item.models[0]?.id ?? '');
                      setOpenPanel(null);
                    }}
                    className="flex shrink-0 h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <Building2 size={20} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{providerName(item)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.alias} · {item.models.length} models</span>
                    </span>
                  </button>
                ))}
            </ToolbarPopover>
          </div>

          <div ref={modelRef} data-testid="model-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'model'}
              aria-label="选择模型"
              onClick={() => setOpenPanel(openPanel === 'model' ? null : 'model')}
              disabled={!provider || models.length === 0}
            >
              <Box size={14} aria-hidden /> {selectedModel ? selectedModel.name : '未配置模型'}
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'model'}
              onClose={() => setOpenPanel(null)}
              anchorRef={modelRef}
              direction={menuDirection}
              role="listbox"
              aria-label="选择模型列表"
              className="flex flex-col gap-2 w-[280px] max-h-[400px] overflow-y-auto no-scrollbar rounded-xl border border-border bg-card p-2"
            >
                <div className="px-3 py-2 text-sm text-muted-foreground">选择模型：{providerDisplayName}</div>
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selectedModel?.id === item.id}
                    onClick={() => {
                      onModelChange?.(item.id);
                      setOpenPanel(null);
                    }}
                    className="flex shrink-0 h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <Box size={22} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.id}</span>
                    </span>
                  </button>
                ))}
            </ToolbarPopover>
          </div>

          {!isVideo && (
            <>
          <div ref={sizeRef} data-testid="size-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'size'}
              aria-label="选择比例和分辨率"
              onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
            >
              <Square size={14} aria-hidden />
              {caps.showCustomSize ? <>{localW}:{localH}</> : <>{ratio}</>}
              <span className="text-muted-foreground">|</span>
              {caps.showResolution
                ? (resolution === '2K' ? '高清 2K' : '超清 4K')
                : (caps.qualities ? (QUALITY_LABELS[quality] ?? quality) : null)}
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
                  <section className="w-[296px]">
                    <div className="py-1 px-1 text-xs text-muted-foreground">比例</div>
                    <div
                      role="listbox"
                      aria-label="选择比例"
                      className="grid rounded-lg bg-popover p-1"
                    >
                      {caps.family !== 'standard' ? (
                        <div className="grid grid-cols-4 gap-y-1">
                          {caps.ratios.map((item) => (
                            <button
                              key={item}
                              type="button"
                              role="option"
                              aria-selected={ratio === item}
                              onClick={() => handleRatioSelect(item)}
                              className="flex h-[43px] w-full flex-col items-center justify-center gap-0.5 rounded-lg text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                            >
                              <RatioIcon ratio={item} box={18} />
                              <span>{item}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="h-[98px] w-[296px] grid grid-cols-[56px_1fr]">
                          <button
                            type="button"
                            role="option"
                            aria-selected={ratio === '1:1'}
                            onClick={() => handleRatioSelect('1:1')}
                            className="flex h-[90px] w-[56px] flex-col items-center justify-center gap-2 rounded-lg text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                          >
                            <RatioIcon ratio="1:1" box={28} />
                            <span>1:1</span>
                          </button>
                          <div data-testid="side-ratio-grid" className="grid min-w-0 grid-cols-4 grid-rows-2 gap-y-1">
                            {SIDE_RATIOS.map((item) => (
                              <button
                                key={item}
                                type="button"
                                role="option"
                                aria-selected={ratio === item}
                                onClick={() => handleRatioSelect(item)}
                                className="flex h-[43px] w-full flex-col items-center justify-center gap-0.5 rounded-lg text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                              >
                                <RatioIcon ratio={item} box={18} />
                                <span>{item}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>

                  {caps.showResolution && (
                    <section className="w-[296px]">
                      <div className="py-1 px-1 text-xs text-muted-foreground">分辨率</div>
                      <div role="listbox" aria-label="选择分辨率" className="grid h-9 grid-cols-2 rounded-lg bg-popover p-0.5">
                        {(['2K', '4K'] as const).map((item) => (
                          <button
                            key={item}
                            type="button"
                            role="option"
                            aria-selected={resolution === item}
                            onClick={() => handleResolutionSelect(item)}
                            className="h-8 rounded-md text-center text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                          >
                            {item === '2K' ? '高清 2K' : '超清 4K'}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  {caps.showCustomSize && (
                      <section className="w-[296px]">
                        <div className="py-1 px-1 text-xs text-muted-foreground">尺寸</div>
                        <div className="flex w-[296px] items-center gap-2">
                          <div className="flex min-w-0 flex-1 items-center h-[34px] rounded-md bg-popover px-4 py-[10px]">
                            <span className="shrink-0 text-xs text-muted-foreground">W</span>
                            <input
                              type="number"
                              aria-label="输出宽度"
                              value={localW}
                              min={minPx}
                              onChange={(e) => handleWChange(e.target.value)}
                              className="min-w-0 flex-1 bg-transparent text-xs tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none pt-[7px] pb-[7px] pl-2 pr-0"
                            />
                          </div>
                          <button
                            type="button"
                            aria-label={sizeLocked ? '解除比例锁定' : '锁定比例'}
                            title={sizeLocked ? '解除比例锁定' : '锁定比例'}
                            onClick={handleToggleLock}
                            className={`grid size-6 shrink-0 place-items-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${sizeLocked ? 'text-primary' : 'text-muted-foreground'}`}
                          >
                            <Link2 size={15} aria-hidden />
                          </button>
                          <div className="flex min-w-0 flex-1 items-center h-[34px] rounded-md bg-popover px-4 py-[10px]">
                            <span className="shrink-0 text-xs text-muted-foreground">H</span>
                            <input
                              type="number"
                              aria-label="输出高度"
                              value={localH}
                              min={minPx}
                              onChange={(e) => handleHChange(e.target.value)}
                              className="min-w-0 flex-1 bg-transparent text-xs tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none pt-[7px] pb-[7px] pl-2 pr-0"
                            />
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">PX</span>
                        </div>
                      </section>
                  )}

                  {caps.qualities && (
                    <section className="w-[296px]">
                      <div className="py-1 px-1 text-xs text-muted-foreground">质量</div>
                      <div
                        role="listbox"
                        aria-label="选择质量"
                        className={`grid h-9 ${caps.qualities.length >= 4 ? 'grid-cols-4' : 'grid-cols-3'} rounded-lg bg-popover p-0.5`}
                      >
                        {caps.qualities.map((item) => (
                          <button
                            key={item}
                            type="button"
                            role="option"
                            aria-selected={quality === item}
                            onClick={() => {
                              onQualityChange?.(item);
                              setOpenPanel(null);
                            }}
                            className="h-8 rounded-md text-center text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                          >
                            {QUALITY_LABELS[item]}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
            </ToolbarPopover>
          </div>

          <div ref={countRef} data-testid="count-control-wrap" className="relative shrink-0">
            <ControlButton
              active={openPanel === 'count'}
              aria-label="选择出图数量"
              onClick={() => setOpenPanel(openPanel === 'count' ? null : 'count')}
            >
              <Images size={14} aria-hidden /> {count} 张
            </ControlButton>
            <ToolbarPopover
              open={openPanel === 'count'}
              onClose={() => setOpenPanel(null)}
              anchorRef={countRef}
              direction={menuDirection}
              role="listbox"
              aria-label="选择出图数量列表"
              className="rounded-xl border border-border bg-card p-3"
            >
                <CountOptions
                  value={count}
                  onSelect={(item) => {
                    onCountChange?.(item);
                    setOpenPanel(null);
                  }}
                />
            </ToolbarPopover>
          </div>
            </>
          )}
          {isVideo && videoCaps && (
            <>
              <VideoControls
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
                  <Images size={14} aria-hidden /> {videoCount} 条
                </ControlButton>
                <ToolbarPopover
                  open={openPanel === 'count'}
                  onClose={() => setOpenPanel(null)}
                  anchorRef={countRef}
                  direction={menuDirection}
                  role="listbox"
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
          </div>
          {/* 渐隐区拦截层：被盖住的控件不可 hover / 点击，必须先滚出来。 */}
          {canScrollRight && (
            <div aria-hidden className="absolute right-0 inset-y-0" style={{ width: scrollBlockWidth }} />
          )}
          {/* 右缘滚动箭头：实心胶囊、浮在最顶层，悬停底栏任意处即现。 */}
          <button
            type="button"
            aria-label="向右滚动查看更多"
            onClick={() => trackRef.current?.scrollBy({ left: 200, behavior: 'smooth' })}
            className={`absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary text-foreground transition-opacity ${
              canScrollRight && barHovering ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            }`}
          >
            <ChevronRight size={17} aria-hidden />
          </button>
        </div>
        {/* pr-12 给提交按钮让位：按钮已改为绝对定位锚在壳右下角（见 shell 末尾），不再占这一行的 flex 位 */}
        <div className="flex items-center gap-3 shrink-0 pr-12">
          {lastFrameOnlyBlocked ? (
            <span
              data-testid="frame-block-hint"
              className="inline-flex items-center gap-1 text-xs text-destructive"
            >
              <Film size={12} aria-hidden />
              需先放首帧
            </span>
          ) : costYuan !== null ? (
            <span
              data-testid="credit-cost-hint"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
            >
              <Coins size={12} aria-hidden />
              {costYuan}
            </span>
          ) : null}
        </div>
      </div>
          </div>
        </div>
      </div>
      {/* 提交按钮：唯一一颗，锚定壳右下角。收/放时壳底边在屏幕上不动，按钮只原位缩放
          40↔32px，不随状态重新挂载——视觉连续性与参考堆叠 / 编辑器的缩放一致。 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); submit(); }}
        disabled={!canSubmit}
        aria-label="提交生成"
        title={lastFrameOnlyBlocked ? 'Seedance 不支持只给尾帧：请先放首帧，或首尾都放' : '提交 (⌘↵)'}
        className={`absolute right-4 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background transition-all duration-300 ${
          collapsed ? 'bottom-[22px] w-8 h-8' : 'bottom-4 w-10 h-10'
        }`}
      >
        <ArrowUp
          size={18}
          aria-hidden
          className={`transition-transform duration-300 ${collapsed ? 'scale-90' : ''}`}
        />
      </button>
    </div>
  );
}

/** 数量弹窗的 1-4 选项（图片张数 / 视频条数共用同一配方）。 */
function CountOptions({ value, onSelect }: { value: number; onSelect: (n: number) => void }) {
  return (
    <div className="flex rounded-lg bg-popover p-1">
      {[1, 2, 3, 4].map((item) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={value === item}
          aria-label={String(item)}
          onClick={() => onSelect(item)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function ControlButton({
  active,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-border bg-secondary text-foreground'
          : 'border-border text-foreground hover:bg-secondary'
      } ${className}`}
      {...props}
    />
  );
}
