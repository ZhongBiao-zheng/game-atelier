import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { RevealImage } from '@/components/ui/reveal-image';
import { animate, MOTION_DURATION, MOTION_EASE, prefersReducedMotion } from '@/lib/motion';

// 遮罩已是不透明度足够的纯色 bg-scrim，按钮不再叠毛玻璃：全屏 backdrop-filter 每帧重算模糊，开合与翻页都卡。
const CONTROL_CLASS = 'absolute size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-background/90 border-0 disabled:pointer-events-none disabled:opacity-30';
// 箭头走 ghost 配方（bare 控件只减不增），这里把它的悬停底色与描边压回大图层的样式。
const ARROW_CLASS = 'top-1/2 -translate-y-1/2 [&_svg]:size-5 hover:border-transparent hover:text-white';
const IMAGE_SCALE_FROM = 0.96;

type Layer = { src: string; phase: 'incoming' | 'shown' | 'leaving' };

/** 没有 matchMedia 的环境（jsdom）不播开合动画，关闭立即生效。 */
function canAnimate() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
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
 * portal 到 body 是硬要求，不是洁癖：`backdrop-filter` 会给 fixed 后代造一个 containing block，
 * 挂在输入壳（bg-glass backdrop-blur-glass）里的 fixed inset-0 会缩到壳那一小条里。
 * 首页/工坊那两处原本就在顶层，portal 对它们无副作用。
 */
export function Lightbox({
  src,
  onClose,
  onPrevious,
  onNext,
  downloadName, details, preloadSrcs,
}: {
  src: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  downloadName?: string;
  details?: ReactNode;
  /** 前后相邻图片的地址：后台预加载，翻页时直接可显示。 */
  preloadSrcs?: readonly string[];
}) {
  const [closing, setClosing] = useState(false);
  const [layers, setLayers] = useState<Layer[]>(() => [{ src, phase: 'incoming' }]);
  const stageRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onPreviousRef = useRef(onPrevious);
  const onNextRef = useRef(onNext);
  onCloseRef.current = onClose;
  onPreviousRef.current = onPrevious;
  onNextRef.current = onNext;

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (!canAnimate()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    const stage = stageRef.current;
    if (stage && !prefersReducedMotion()) {
      animate(stage, { scale: IMAGE_SCALE_FROM }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle });
    }
    // 遮罩的 scrimOut 也是 150ms；等它播完再卸载，退场不会被截掉。
    window.setTimeout(() => onCloseRef.current(), MOTION_DURATION.fast * 1000);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (closingRef.current) return;
      if (e.key === 'Escape') requestClose();
      if (e.key === 'ArrowLeft' && onPreviousRef.current) {
        e.preventDefault();
        onPreviousRef.current();
      }
      if (e.key === 'ArrowRight' && onNextRef.current) {
        e.preventDefault();
        onNextRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [requestClose]);

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
    const stage = stageRef.current;
    if (opened.current || !stage) return;
    opened.current = true;
    if (canAnimate() && !prefersReducedMotion() && !closingRef.current) {
      animate(stage, { scale: [IMAGE_SCALE_FROM, 1] }, { duration: MOTION_DURATION.base, ease: MOTION_EASE.out });
    }
  }, []);

  const leaving = layers.some(layer => layer.phase === 'leaving');
  useEffect(() => {
    if (!leaving) return;
    // 旧图与新图同步淡出淡入（duration-200），播完再移走。
    const timer = window.setTimeout(() => {
      setLayers(current => current.filter(layer => layer.phase !== 'leaving'));
    }, MOTION_DURATION.base * 1000);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    for (const next of preloadSrcs ?? []) {
      if (next === src) continue;
      const image = new Image();
      image.src = next;
      void image.decode?.().catch(() => undefined);
    }
  }, [preloadSrcs, src]);

  return createPortal(
    <div
      data-state={closing ? 'closed' : 'open'}
      className="scrim-fade fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={requestClose}
    >
      <div ref={stageRef} className="grid place-items-center">
        {layers.map(layer => (
          <RevealImage
            key={layer.src}
            src={layer.src}
            alt={layer.src === src ? '大图' : ''}
            aria-hidden={layer.src === src ? undefined : true}
            onReady={() => handleReady(layer.src)}
            className={`media-checker col-start-1 row-start-1 max-h-[90vh] max-w-[90vw] rounded-lg object-contain ${layer.phase === 'leaving' ? 'pointer-events-none opacity-0' : ''}`}
            onClick={(e) => e.stopPropagation()}
          />
        ))}
      </div>
      {details && <div className="absolute inset-x-4 bottom-4 mx-auto max-h-[25vh] max-w-xl overflow-auto break-words rounded-lg bg-card p-3 text-sm text-foreground" onClick={event => event.stopPropagation()}>{details}</div>}
      <Button variant="bare"
        type="button"
        aria-label="关闭"
        onClick={(e) => { e.stopPropagation(); requestClose(); }}
        className={`${CONTROL_CLASS} desktop-clear-top right-6 top-6`}
      >
        <CloseIcon size="lg" />
      </Button>
      {downloadName && (
        <a
          href={src}
          download={downloadName}
          aria-label="下载图片"
          onClick={(e) => e.stopPropagation()}
          className={`${CONTROL_CLASS} desktop-clear-top right-20 top-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
        >
          <DownloadIcon size="lg" aria-hidden />
        </a>
      )}
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
