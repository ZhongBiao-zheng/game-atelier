import { type ButtonHTMLAttributes, type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUp, Box, Coins, Film, ImageIcon, Images, Music, Plus, Square, Building2, Link2, Video, X } from 'lucide-react';
import { modelModality, type KeyView } from '@/api/keys';
import { computeStudioPixelSize, normalizeStudioPixelSizeForModel } from '@/lib/studioSize';
import { providerLabel } from '@/lib/providerLabels';
import { maxReferenceImages } from '@/lib/referenceLimits';
import { imageControlCaps, QUALITY_LABELS, type Quality } from '@/lib/imageControlCaps';
import { estimateCostYuan, isHkAggregator } from '@/lib/creditCost';
import { VideoControls } from './VideoControls';
import {
  FirstLastFrames,
  MAX_REF_AUDIOS,
  MAX_REF_IMAGES,
  MAX_REF_VIDEOS,
  type FrameSlots,
} from './VideoReferenceAssets';
import { RatioIcon } from './RatioIcon';
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
  const [refExpanded, setRefExpanded] = useState(false);
  const [refHovered, setRefHovered] = useState<number | null>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const refInputId = useId();
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
  const refPreviews = useMemo(
    () => stackItems.map((item) => (item.kind === 'image' ? URL.createObjectURL(item.file) : null)),
    [stackItems],
  );
  useEffect(() => () => refPreviews.forEach((u) => { if (u) URL.revokeObjectURL(u); }), [refPreviews]);

  useEffect(() => {
    if (!openPanel) return;
    function handleMouseDown(e: MouseEvent) {
      if (shellRef.current && !shellRef.current.contains(e.target as Node)) {
        setOpenPanel(null);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [openPanel]);
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
  const canSubmit = Boolean(provider && selectedModel && text.trim() && !disabled);
  // 消耗提示只对 OpenAI-HK 聚合商显示（人民币，无单位）；未定价的模型/档位返回 null 即隐藏。
  const costYuan = isHkAggregator(provider?.base_url)
    ? estimateCostYuan({ model: selectedModel?.id, quality, n: isVideo ? videoCount : count })
    : null;
  const panelPosition = menuDirection === 'down'
    ? 'top-full mt-3'
    : 'bottom-full mb-3';
  const minPx = 1;

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
    const trimmed = text.trim();
    if (!trimmed || disabled || !provider || !selectedModel) return;
    onSubmit(trimmed);
  }, [text, disabled, provider, selectedModel, onSubmit]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  function handleRefAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    if (isOmni) {
      // 单入口收所有类型：按 MIME 分流进各自数组并执行 9/3/3 上限。
      const images = [...referenceImages];
      const videos = [...referenceVideos];
      const audios = [...referenceAudios];
      for (const file of Array.from(files)) {
        if (file.type.startsWith('video/')) {
          if (videoCaps?.supportsReferenceVideo && videos.length < maxRefVids) videos.push(file);
        } else if (file.type.startsWith('audio/')) {
          if (videoCaps?.supportsReferenceAudio && audios.length < MAX_REF_AUDIOS) audios.push(file);
        } else if (file.type.startsWith('image/')) {
          if (images.length < maxRefImgs) images.push(file);
        }
      }
      onReferenceImagesChange?.(images);
      onReferenceVideosChange?.(videos);
      onReferenceAudiosChange?.(audios);
    } else {
      onReferenceImagesChange?.([...referenceImages, ...Array.from(files)].slice(0, maxRef));
    }
    e.target.value = '';
  }

  function handleRefRemove(idx: number) {
    const item = stackItems[idx];
    if (!item) return;
    if (item.kind === 'video') {
      const j = idx - referenceImages.length;
      onReferenceVideosChange?.(referenceVideos.filter((_, i) => i !== j));
    } else if (item.kind === 'audio') {
      const j = idx - referenceImages.length - referenceVideos.length;
      onReferenceAudiosChange?.(referenceAudios.filter((_, i) => i !== j));
    } else {
      onReferenceImagesChange?.(referenceImages.filter((_, i) => i !== idx));
    }
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
      className={`bg-glass rounded-xl border border-input px-4 max-w-[780px] mx-auto relative z-20 backdrop-blur-glass h-auto flex flex-col pointer-events-auto transition-all duration-300 ${
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
                    const angle = refExpanded ? expandAngle(i) : collapseAngle(i);
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
                        <div className="w-full h-full rounded-lg overflow-hidden border-[1.5px] border-white bg-card">
                          {item.kind === 'image' ? (
                            <img src={refPreviews[i] ?? ''} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted-foreground">
                              {item.kind === 'video' ? <Film size={18} aria-hidden /> : <Music size={18} aria-hidden />}
                              <span className="w-full truncate text-center text-xs">{item.file.name}</span>
                            </div>
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
                  {stackCanAdd && (
                    <label
                      htmlFor={refInputId}
                      className="absolute flex items-center justify-center rounded-full border-[0.5px] border-border bg-secondary cursor-pointer text-muted-foreground hover:text-foreground hover:border-input hover:bg-card transition-colors"
                      style={{
                        width: 28,
                        height: 28,
                        zIndex: 45,
                        top: '50%',
                        marginTop: 15,
                        left: `${(refExpanded ? (stackItems.length - 1) * REF_W : 0) + REF_W - 20}px`,
                        transform: `rotate(${refExpanded ? expandAngle(stackItems.length - 1) : collapseAngle(stackItems.length - 1)}deg)`,
                        transition: 'left 300ms ease, transform 300ms ease',
                      }}
                    >
                      <Plus size={14} />
                    </label>
                  )}
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
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="开始一段灵感对话..."
          className={`flex-1 min-h-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none rounded-md px-2 transition-[height] duration-300 ${
            collapsed ? 'h-6 self-center overflow-hidden' : 'h-full'
          }`}
          aria-label="生图 prompt"
        />
        {collapsed && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); submit(); }}
            disabled={!canSubmit}
            aria-label="提交生成"
            title="提交 (⌘↵)"
            className="self-center shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors"
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        )}
      </div>
      {/* 控件行收放：grid-rows 0fr/1fr 让 auto 高度可动画；收缩时才 overflow-hidden，
          展开态必须可见——弹窗（bottom-full）要溢出这层渲染。 */}
      <div
        className={`grid transition-all duration-300 ${
          collapsed ? 'grid-rows-[0fr] opacity-0 pointer-events-none' : 'grid-rows-[1fr] opacity-100'
        }`}
      >
        <div className={`min-h-0 ${collapsed ? 'overflow-hidden' : ''}`}>
      <div className="flex flex-wrap justify-between items-center gap-3 shrink-0">
        <div className="flex min-w-0 flex-wrap gap-2">
          <div data-testid="kind-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'kind'}
              aria-label="选择生成模式"
              onClick={() => setOpenPanel(openPanel === 'kind' ? null : 'kind')}
            >
              {isVideo ? <Video size={14} aria-hidden /> : <ImageIcon size={14} aria-hidden />}
              {isVideo ? '视频生成' : '图片生成'}
            </ControlButton>
            {openPanel === 'kind' && (
              <div role="listbox" aria-label="生成模式列表" className={`absolute left-0 ${panelPosition} z-20 w-[200px] rounded-xl border border-border bg-card p-2`}>
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
              </div>
            )}
          </div>

          <div data-testid="provider-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'provider'}
              aria-label="选择厂商"
              onClick={() => setOpenPanel(openPanel === 'provider' ? null : 'provider')}
              disabled={visibleProviders.length === 0}
            >
              <Building2 size={14} aria-hidden /> {providerDisplayName}
            </ControlButton>
            {openPanel === 'provider' && (
              <div role="listbox" aria-label="选择厂商列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-xl border border-border bg-card p-2`}>
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
                    className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <Building2 size={20} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{providerName(item)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.alias} · {item.models.length} models</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div data-testid="model-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'model'}
              aria-label="选择模型"
              onClick={() => setOpenPanel(openPanel === 'model' ? null : 'model')}
              disabled={!provider || models.length === 0}
            >
              <Box size={14} aria-hidden /> {selectedModel ? selectedModel.name : '未配置模型'}
            </ControlButton>
            {openPanel === 'model' && (
              <div role="listbox" aria-label="选择模型列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-xl border border-border bg-card p-2`}>
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
                    className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <Box size={22} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.id}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {!isVideo && (
            <>
          <div data-testid="size-control-wrap" className="relative">
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
            {openPanel === 'size' && (
              <div data-testid="size-popover" className={`absolute left-0 ${panelPosition} z-20 w-[320px] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-3`}>
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
              </div>
            )}
          </div>

          <div data-testid="count-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'count'}
              aria-label="选择出图数量"
              onClick={() => setOpenPanel(openPanel === 'count' ? null : 'count')}
            >
              <Images size={14} aria-hidden /> {count} 张
            </ControlButton>
            {openPanel === 'count' && (
              <div role="listbox" aria-label="选择出图数量列表" className={`absolute left-0 ${panelPosition} z-20 rounded-xl border border-border bg-card p-3`}>
                <CountOptions
                  value={count}
                  onSelect={(item) => {
                    onCountChange?.(item);
                    setOpenPanel(null);
                  }}
                />
              </div>
            )}
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
              <div data-testid="video-count-control-wrap" className="relative">
                <ControlButton
                  active={openPanel === 'count'}
                  aria-label="选择视频生成数量"
                  onClick={() => setOpenPanel(openPanel === 'count' ? null : 'count')}
                >
                  <Images size={14} aria-hidden /> {videoCount} 条
                </ControlButton>
                {openPanel === 'count' && (
                  <div role="listbox" aria-label="选择视频生成数量列表" className={`absolute left-0 ${panelPosition} z-20 rounded-xl border border-border bg-card p-3`}>
                    <CountOptions
                      value={videoCount}
                      onSelect={(item) => {
                        onVideoCountChange?.(item);
                        setOpenPanel(null);
                      }}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {costYuan !== null && (
            <span
              data-testid="credit-cost-hint"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
            >
              <Coins size={12} aria-hidden />
              {costYuan}
            </span>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            aria-label="提交生成"
            title="提交 (⌘↵)"
            className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background transition-colors"
          >
            <ArrowUp size={18} aria-hidden />
          </button>
        </div>
      </div>
        </div>
      </div>
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
