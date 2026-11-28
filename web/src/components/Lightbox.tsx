import { FrozenGenerationDetails } from '@/components/canvas/FrozenGenerationDetails';
import type { CanvasFrozenGeneration } from '@/schema/canvas';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AddIcon, AddImageIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CollapseIcon, CopyIcon, DeleteIcon, DownloadIcon, ExpandIcon, MinusIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { RevealImage } from '@/components/ui/reveal-image';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { Hint } from '@/components/ui/tooltip';
import { ModelBrandIcon } from '@/components/ModelBrandIcon';
import { MetaTag } from '@/components/MetaTag';
import { modelBrand } from '@/lib/modelCatalog';
import { useCopyFeedback } from '@/lib/useCopyFeedback';
import { MOTION_DURATION, motionAvailable } from '@/lib/motion';
import { LIGHTBOX_ZOOM_STEP, useLightboxZoom } from './useLightboxZoom';
import { ZOOM_DOCK_BUTTON_CLASS, ZOOM_DOCK_PERCENT_CLASS } from './zoomDock';
import { useLightboxTransition } from './useLightboxTransition';

export interface LightboxMediaMeta {
  frozenGeneration?: { generation: CanvasFrozenGeneration; mediaUrl: (versionId: string) => string };
  title?: string;
  prompt?: string;
  model?: string;
  modelId?: string;
  provider?: string;
  dimensions?: string;
  quality?: string;
  duration?: string;
  cost?: string;
  createdAt?: string;
  tags?: readonly string[];
  extra?: ReactNode;
}

// 遮罩已是不透明度足够的纯色 bg-scrim，按钮不再叠毛玻璃：全屏 backdrop-filter 每帧重算模糊，开合与翻页都卡。
const CONTROL_CLASS = 'absolute size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-scrim-strong border-0 disabled:pointer-events-none disabled:opacity-30';
// 箭头走 ghost 配方（bare 控件只减不增），这里把它的悬停底色与描边压回大图层的样式。
const ARROW_CLASS = 'top-1/2 -translate-y-1/2 [&_svg]:size-5 hover:border-transparent hover:text-white';
// 缩放栏按钮：画布缩放栏同款外观，走 ghost 配方（bare 控件只减不增），压掉 ghost 的悬停描边与玻璃。
const DOCK_BUTTON_CLASS = `${ZOOM_DOCK_BUTTON_CLASS} hover:border-transparent hover:backdrop-blur-none`;
// 右上角动作组里的按钮：与关闭按钮同一外观，但排在 flex 行里，不各自绝对定位。
// 走 ghost 配方（bare 控件只减不增），悬停描边与文字色压回大图层的样式。
const ACTION_CLASS = 'size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-scrim-strong hover:border-transparent hover:text-white [&_svg]:size-6';


type Layer = { src: string; phase: 'incoming' | 'shown' | 'leaving' };

/** 焦点在可输入元素里时，⌫ 是删字，不是删图。 */
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.closest('[contenteditable=true], [contenteditable=""]') !== null || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}


/** 全屏大图层：点遮罩 / 右上角 / Esc 关闭。
 *
 * 开合：遮罩与控件整体淡入淡出（scrim-fade），图片解码后从 96% 放大到原尺寸；关闭先播完 150ms 退场再调 onClose，
 * 调用方照常条件渲染，不用改。减弱动态效果时只淡入淡出。
 * 翻页：旧图留在原地，新图解码完成后叠在上面交叉淡化，不经过空白；两张图各按自己的尺寸居中，不拉伸不跳。
 * preloadSrcs 传前后几张的地址，翻页时新图多半已在缓存里。
 *
 * 传了 onPrevious / onNext 任意一个就显示左右箭头；缺的那一侧表示已到头，箭头置灰。
 * 传 downloadName 时右上角多一个下载按钮。
 *
 * 可选动作（规格 2.5，不传就不显示，图标按钮 + Hint）：onDownload（优先于 downloadName 的直链下载）、
 * onUseAsReference「设为参考」、onCopyPrompt（返回要复制的提示词，按钮原位换勾）、onDelete。
 * onDelete 由「删除」按钮或 ⌫ / Delete 键触发，随后翻到下一张（没有下一张翻上一张，都没有就关闭）——
 * 调用方须按身份（id / src）记当前项、不按下标，删掉的那张从列表里消失后才不会错位；撤销 toast 由调用方发（notify.undo）。
 * onDelete 返回 Promise<boolean> 时等服务端受理（true）才翻页；deleting 为真时删除按钮与快捷键都不响应，
 * 连按不会出现「翻了页却没删」。
 *
 * portal 到 body 是硬要求，不是洁癖：`backdrop-filter` 会给 fixed 后代造一个 containing block，
 * 挂在输入壳（bg-glass backdrop-blur-glass）里的 fixed inset-0 会缩到壳那一小条里。
 * 首页/工坊那两处原本就在顶层，portal 对它们无副作用。
 */
export function Lightbox({
  src, sourceRect, bottomActions, imageOverlay,
  onClose,
  onPrevious,
  onNext,
  downloadName, details, meta, counter, preloadSrcs,
  onDownload, onUseAsReference, onCopyPrompt, onDelete, deleting = false,
}: {
  src: string;
  sourceRect?: DOMRect | null;
  bottomActions?: ReactNode;
  imageOverlay?: ReactNode;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  downloadName?: string;
  details?: ReactNode;
  /** 结构化媒体信息：传入时进入全站统一图文分离详情态（桌面左图右栏，窄屏上图下栏）。 */
  meta?: LightboxMediaMeta;
  /** 同批多图翻页计数（如 2 / 8）。 */
  counter?: { current: number; total: number };
  /** 前后相邻图片的地址：后台预加载，翻页时直接可显示。 */
  preloadSrcs?: readonly string[];
  onDownload?: () => void;
  onUseAsReference?: () => void;
  /** 返回当前这张的提示词；由 Lightbox 写剪贴板并原位换勾。 */
  onCopyPrompt?: () => string;
  /** 返回 Promise 时，resolve(true) 表示已受理，才翻页。 */
  onDelete?: () => void | Promise<boolean>;
  /** 调用方的删除还在进行：删除按钮禁用，⌫ / Delete 不响应。 */
  deleting?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const [layers, setLayers] = useState<Layer[]>(() => [{ src, phase: 'incoming' }]);
  const { viewport, plane, image, percent, preset, fitsWhole, paint, zoomTo, zoomBy, zoomStep, handlers } = useLightboxZoom(src);
  const { transition, cancel: cancelTransition } = useLightboxTransition(image, viewport, sourceRect, src);
  const closeTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const dialog = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const opened = useRef(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onPreviousRef = useRef(onPrevious);
  const onNextRef = useRef(onNext);
  onCloseRef.current = onClose;
  const onDeleteRef = useRef(onDelete);
  onPreviousRef.current = onPrevious;
  onNextRef.current = onNext;
  onDeleteRef.current = onDelete;
  const deletingRef = useRef(deleting);
  deletingRef.current = deleting;
  const srcRef = useRef(src);
  srcRef.current = src;
  const [copyState, copy] = useCopyFeedback();

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (!motionAvailable()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    transition(true);
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), MOTION_DURATION.fast * 1000);
  }, [transition]);

  const deleteCurrent = useCallback(() => {
    const remove = onDeleteRef.current;
    if (!remove || closingRef.current || deletingRef.current) return;
    const move = (advance: (() => void) | undefined) => { if (advance) advance(); else requestClose(); };
    const deleted = srcRef.current;
    const result = remove();
    // 异步删除：受理后只在仍停在被删那张时才推进；等待期间已经翻走就不打扰。邻居按此刻的列表取。
    if (result instanceof Promise) {
      void result.then(accepted => {
        if (accepted && !closingRef.current && srcRef.current === deleted) move(onNextRef.current ?? onPreviousRef.current);
      });
      return;
    }
    // 同步删除：翻页目标按删除前这一帧取，删掉的那张还在列表里，邻居就是它前后的那张。
    move(onNextRef.current ?? onPreviousRef.current);
  }, [requestClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (closingRef.current) return;
      if (e.key === 'Tab' && dialog.current) {
        const controls = dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, select, [contenteditable=true], [tabindex="0"]');
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === dialog.current || document.activeElement === first)) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first?.focus();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); requestClose(); return;
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (['0', '1', '+', '=', '-'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        cancelTransition();
        if (e.key === '0' || e.key === '1') zoomTo(e.key === '0' ? null : 1);
        else zoomBy(e.key === '-' ? 1 / LIGHTBOX_ZOOM_STEP : LIGHTBOX_ZOOM_STEP);
        return;
      }
      if (e.key === 'ArrowLeft' && onPreviousRef.current) {
        e.preventDefault();
        onPreviousRef.current();
      }
      if (e.key === 'ArrowRight' && onNextRef.current) {
        e.preventDefault();
        onNextRef.current();
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && onDeleteRef.current && !isTypingTarget(e.target)) {
        e.preventDefault();
        deleteCurrent();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [requestClose, deleteCurrent, zoomTo, zoomBy, cancelTransition]);

  // 换图：还没显示出来的新图直接作废，只叠最新这张；已显示的旧图留着垫底，等新图就绪。
  useLayoutEffect(() => {
    setLayers(current => {
      const existing = current.find(layer => layer.src === src);
      // 快速来回翻：要的图还在原地（正显示或正淡出），直接让它回到显示态，不重新解码。
      if (existing && existing.phase !== 'incoming') {
        return current.flatMap((layer): Layer[] => {
          if (layer.src === src) return [{ ...layer, phase: 'shown' as const }];
          if (layer.phase === 'incoming') return [];
          return [{ ...layer, phase: 'leaving' as const }];
        });
      }
      if (existing) return current;
      return [...current.filter(layer => layer.phase !== 'incoming'), { src, phase: 'incoming' }];
    });
  }, [src]);

  const handleReady = useCallback((readySrc: string) => {
    setLayers(current => {
      if (!current.some(layer => layer.src === readySrc && layer.phase === 'incoming')) return current;
      return current.flatMap((layer): Layer[] => {
        if (layer.src === readySrc) return [{ ...layer, phase: 'shown' as const }];
        if (layer.phase === 'shown') return [{ ...layer, phase: 'leaving' as const }];
        return layer.phase === 'leaving' ? [layer] : [];
      });
    });
    // 第一张图就绪时放大进场；之后翻页只做交叉淡化。
    if (readySrc !== src) return;
    paint();
    if (opened.current || closingRef.current) return;
    opened.current = true;
    transition(false);
  }, [paint, src, transition]);

  // 每个离场层各按自己的截止时间移走：旧图与新图同步淡出淡入（duration-200），从它开始离场算起播完再卸载。
  // 连翻三张时第二张不会跟着第一张的计时被提前拿掉；回到某张正在离场的图，取消它的清理。
  const leaveTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = leaveTimers.current;
    for (const [leavingSrc, timer] of timers) {
      if (layers.some(layer => layer.src === leavingSrc && layer.phase === 'leaving')) continue;
      window.clearTimeout(timer);
      timers.delete(leavingSrc);
    }
    for (const layer of layers) {
      if (layer.phase !== 'leaving' || timers.has(layer.src)) continue;
      const leavingSrc = layer.src;
      timers.set(leavingSrc, window.setTimeout(() => {
        timers.delete(leavingSrc);
        setLayers(current => current.filter(item => !(item.src === leavingSrc && item.phase === 'leaving')));
      }, MOTION_DURATION.base * 1000));
    }
  }, [layers]);
  useEffect(() => {
    const timers = leaveTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    for (const next of preloadSrcs ?? []) {
      if (next === src) continue;
      const image = new Image();
      image.src = next;
      void image.decode?.().catch(() => undefined);
    }
  }, [preloadSrcs, src]);

  const hasPanel = Boolean(meta || details);
  const specRows: { label: string; value: string; brandId?: string }[] = meta
    ? [
      meta.model ? { label: '模型', value: meta.model, brandId: meta.modelId ?? meta.model } : null,
      meta.provider ? { label: '平台', value: meta.provider } : null,
      meta.dimensions ? { label: '尺寸', value: meta.dimensions } : null,
      meta.quality ? { label: '质量', value: meta.quality } : null,
      meta.duration ? { label: '耗时', value: meta.duration } : null,
      meta.cost ? { label: '费用', value: meta.cost } : null,
      meta.createdAt ? { label: '时间', value: meta.createdAt } : null,
    ].filter((row): row is { label: string; value: string; brandId?: string } => row !== null)
    : [];
  const promptCopyText = onCopyPrompt ?? (meta?.prompt ? () => meta.prompt! : undefined);
  const showFooterCopy = Boolean(promptCopyText && !meta?.prompt);
  const hasFooterActions = Boolean(onUseAsReference || onDownload || downloadName || showFooterCopy || onDelete);

  const mediaStage = <>
    {/* 与画布右下角缩放栏同一形态：− 百分比 +，再加一颗「适配 / 实际大小」切换。图片原尺寸就放得下时两者同画面，切换禁用。 */}
    <div role="group" aria-label="图片缩放" className="relative z-10 mx-auto my-1 flex shrink-0 items-center gap-1 rounded-full border border-border bg-card p-1"
      onClick={event => event.stopPropagation()}>
      <Button variant="ghost" size="icon" type="button" aria-label="缩小" disabled={percent <= 25} className={DOCK_BUTTON_CLASS}
        onClick={() => { cancelTransition(); zoomStep(-1); }}><MinusIcon aria-hidden="true" /></Button>
      <output aria-label="当前缩放" className={`${ZOOM_DOCK_PERCENT_CLASS} grid place-items-center`}>{percent}%</output>
      <Button variant="ghost" size="icon" type="button" aria-label="放大" disabled={percent >= 400} className={DOCK_BUTTON_CLASS}
        onClick={() => { cancelTransition(); zoomStep(1); }}><AddIcon aria-hidden="true" /></Button>
      <div className="mx-1 h-5 w-px bg-border" />
      <Hint label={preset === null ? '实际大小' : '适配'}>
        <Button variant="ghost" size="icon" type="button" aria-label={preset === null ? '实际大小' : '适配'}
          disabled={fitsWhole && (preset === null || preset === 1)} className={DOCK_BUTTON_CLASS}
          onClick={() => { cancelTransition(); zoomTo(preset === null ? 1 : null); }}>
          <SwapIcon swapKey={preset === null}>{preset === null ? <ExpandIcon aria-hidden="true" /> : <CollapseIcon aria-hidden="true" />}</SwapIcon>
        </Button>
      </Hint>
    </div>
    <div ref={viewport} data-lightbox-viewport="" {...handlers}
      onPointerDownCapture={cancelTransition} onWheelCapture={cancelTransition}
      className="relative min-h-0 w-full flex-1 touch-none overflow-hidden [container-type:size] data-[pannable=true]:cursor-grab data-[dragging=true]:cursor-grabbing">
      <div ref={plane} className="absolute inset-0 grid grid-cols-1 grid-rows-1 place-items-center">
        {layers.map(layer => <div key={layer.src} className="relative col-start-1 row-start-1" onClick={event => event.stopPropagation()}>
          <RevealImage ref={layer.src === src ? image : undefined} src={layer.src} draggable={false}
            alt={layer.src === src ? '大图' : ''} aria-hidden={layer.src === src ? undefined : true}
            onReady={() => handleReady(layer.src)}
            className={`media-checker block max-h-[100cqh] max-w-[100cqw] select-none rounded-lg object-contain ${layer.phase === 'leaving' ? 'pointer-events-none opacity-0' : ''}`} />
          {layer.src === src && imageOverlay}
        </div>)}
      </div>
    </div>
    {bottomActions && <div role="group" aria-label="图片快捷操作" className="mx-auto mt-2 flex shrink-0 items-center gap-1 rounded-full border border-border bg-card p-1"
      onClick={event => event.stopPropagation()}>{bottomActions}</div>}
  </>;
  if (hasPanel) {
    return createPortal(
      <div
        data-state={closing ? 'closed' : 'open'}
        className="scrim-fade fixed inset-0 z-50 flex items-center justify-center bg-scrim p-3 md:p-6"
        onClick={requestClose}
      >
        <div
          ref={dialog} tabIndex={-1} role="dialog"
          aria-modal="true"
          aria-label={meta?.title || '作品详情'}
          data-testid="media-detail-dialog"
          className="flex h-[90dvh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-card md:flex-row"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 左侧（窄屏上方）：纯媒体舞台，绝无文字或参数遮挡 */}
          <div className="relative flex h-[58%] min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background p-3 md:h-full md:p-4">
            {mediaStage}
            {(onPrevious || onNext) && (
              <>
                <Button variant="ghost" size="icon"
                  type="button"
                  aria-label="上一张"
                  disabled={!onPrevious}
                  onClick={() => onPrevious?.()}
                  className={`${CONTROL_CLASS} ${ARROW_CLASS} left-3`}
                >
                  <ChevronLeftIcon size="lg" />
                </Button>
                <Button variant="ghost" size="icon"
                  type="button"
                  aria-label="下一张"
                  disabled={!onNext}
                  onClick={() => onNext?.()}
                  className={`${CONTROL_CLASS} ${ARROW_CLASS} right-3`}
                >
                  <ChevronRightIcon size="lg" />
                </Button>
              </>
            )}
          </div>

          {/* 右侧（窄屏下方）：独立结构化信息栏与操作栏 */}
          <aside className="flex h-[42%] w-full shrink-0 flex-col border-t border-border bg-card md:h-full md:w-88 lg:w-96 md:border-l md:border-t-0">
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{meta?.title || '作品详情'}</span>
                {counter && counter.total > 1 && (
                  <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                    {counter.current} / {counter.total}
                  </span>
                )}
              </div>
              <Button variant="ghost" size="icon" type="button" aria-label="关闭" onClick={requestClose} className="size-8 shrink-0 rounded-full">
                <CloseIcon size="md" />
              </Button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              {meta?.frozenGeneration && <FrozenGenerationDetails {...meta.frozenGeneration} />}
              {meta?.prompt && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">提示词</span>
                    {promptCopyText && (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        aria-label="复制提示词"
                        onClick={() => copy(promptCopyText())}
                        className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <SwapIcon swapKey={copyState === 'copied'} variant="pop">
                          {copyState === 'copied' ? <CheckIcon size="sm" aria-hidden /> : <CopyIcon size="sm" aria-hidden />}
                        </SwapIcon>
                        <SwapLabel active={copyState === 'copied'} on="已复制" off="复制" />
                      </Button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words rounded-lg bg-popover p-3 text-sm leading-relaxed text-foreground">
                    {meta.prompt}
                  </p>
                </section>
              )}

              {(specRows.length > 0 || (meta?.tags && meta.tags.length > 0)) && (
                <section className="space-y-2">
                  <span className="block text-xs text-muted-foreground">生成参数</span>
                  {specRows.length > 0 && (
                    <dl className="divide-y divide-border rounded-lg border border-border bg-popover/60">
                      {specRows.map(row => (
                        <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
                          <dd className="flex min-w-0 items-center gap-1.5 truncate font-medium tabular-nums text-foreground">
                            {row.brandId && <ModelBrandIcon brand={modelBrand(row.brandId)} size="sm" />}
                            <span className="truncate">{row.value}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {meta?.tags && meta.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {meta.tags.map((tag, idx) => <MetaTag key={idx}>{tag}</MetaTag>)}
                    </div>
                  )}
                </section>
              )}

              {meta?.extra && <div className="space-y-2">{meta.extra}</div>}
              {details && <div className="space-y-3 text-sm text-foreground">{details}</div>}
            </div>

            {hasFooterActions && (
              <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
                {onUseAsReference && (
                  <Button variant="secondary" size="sm" type="button" aria-label="设为参考" onClick={onUseAsReference} className="gap-1.5">
                    <AddImageIcon size="sm" aria-hidden />设为参考
                  </Button>
                )}
                {showFooterCopy && promptCopyText && (
                  <Button variant="secondary" size="sm" type="button" aria-label="复制提示词" onClick={() => copy(promptCopyText())} className="gap-1.5">
                    <SwapIcon swapKey={copyState === 'copied'} variant="pop">
                      {copyState === 'copied' ? <CheckIcon size="sm" aria-hidden /> : <CopyIcon size="sm" aria-hidden />}
                    </SwapIcon>
                    <SwapLabel active={copyState === 'copied'} on="已复制" off="复制提示词" />
                  </Button>
                )}
                {onDownload ? (
                  <Button variant="secondary" size="sm" type="button" aria-label="下载图片" onClick={onDownload} className="gap-1.5">
                    <DownloadIcon size="sm" aria-hidden />下载
                  </Button>
                ) : downloadName && (
                  <Button variant="secondary" size="sm" asChild className="gap-1.5">
                    <a href={src} download={downloadName} aria-label="下载图片">
                      <DownloadIcon size="sm" aria-hidden />下载
                    </a>
                  </Button>
                )}
                {onDelete && (
                  <Hint label="删除（⌫）">
                    <Button variant="ghost" size="icon" type="button" aria-label="删除" disabled={deleting} onClick={deleteCurrent} className="ml-auto size-8 text-muted-foreground hover:text-destructive">
                      <DeleteIcon size="sm" aria-hidden />
                    </Button>
                  </Hint>
                )}
              </footer>
            )}
          </aside>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="图片预览"
      data-state={closing ? 'closed' : 'open'}
      className="scrim-fade fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={requestClose}
    >
      <div className="flex h-[90dvh] w-[90vw] flex-col pt-12 sm:pt-0">
        {mediaStage}
      </div>
      <Button variant="bare"
        type="button"
        aria-label="关闭"
        onClick={(e) => { e.stopPropagation(); requestClose(); }}
        className={`${CONTROL_CLASS} desktop-clear-top right-6 top-6`}
      >
        <CloseIcon size="lg" />
      </Button>
      <div className="desktop-clear-top absolute right-20 top-6 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {onCopyPrompt && <Hint label={copyState === 'failed' ? '复制失败' : '复制提示词'}>
          <Button variant="ghost" size="icon" type="button" aria-label="复制提示词" onClick={() => copy(onCopyPrompt())}
            className={ACTION_CLASS}>
            <SwapIcon swapKey={copyState === 'copied'} variant="pop">
              {copyState === 'copied' ? <CheckIcon size="lg" aria-hidden /> : <CopyIcon size="lg" aria-hidden />}
            </SwapIcon>
          </Button>
        </Hint>}
        {onUseAsReference && <Hint label="设为参考">
          <Button variant="ghost" size="icon" type="button" aria-label="设为参考" onClick={onUseAsReference} className={ACTION_CLASS}>
            <AddImageIcon size="lg" aria-hidden />
          </Button>
        </Hint>}
        {onDownload ? <Hint label="下载">
          <Button variant="ghost" size="icon" type="button" aria-label="下载图片" onClick={onDownload} className={ACTION_CLASS}>
            <DownloadIcon size="lg" aria-hidden />
          </Button>
        </Hint> : downloadName && <Hint label="下载">
          <a
            href={src}
            download={downloadName}
            aria-label="下载图片"
            className={`${ACTION_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
          >
            <DownloadIcon size="lg" aria-hidden />
          </a>
        </Hint>}
        {onDelete && <Hint label="删除（⌫）">
          <Button variant="ghost" size="icon" type="button" aria-label="删除" disabled={deleting} onClick={deleteCurrent} className={ACTION_CLASS}>
            <DeleteIcon size="lg" aria-hidden />
          </Button>
        </Hint>}
      </div>
      {(onPrevious || onNext) && (
        <>
          <Button variant="ghost" size="icon"
            type="button"
            aria-label="上一张"
            disabled={!onPrevious}
            onClick={(e) => { e.stopPropagation(); onPrevious?.(); }}
            className={`${CONTROL_CLASS} ${ARROW_CLASS} left-6`}
          >
            <ChevronLeftIcon size="lg" />
          </Button>
          <Button variant="ghost" size="icon"
            type="button"
            aria-label="下一张"
            disabled={!onNext}
            onClick={(e) => { e.stopPropagation(); onNext?.(); }}
            className={`${CONTROL_CLASS} ${ARROW_CLASS} right-6`}
          >
            <ChevronRightIcon size="lg" />
          </Button>
        </>
      )}
    </div>,
    document.body,
  );
}
