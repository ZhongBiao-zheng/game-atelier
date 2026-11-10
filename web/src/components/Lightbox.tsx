import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';

const CONTROL_CLASS = 'absolute size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-background/90 backdrop-blur-glass border-0 disabled:pointer-events-none disabled:opacity-30';
// 箭头走 ghost 配方（bare 控件只减不增），这里把它的悬停底色与描边压回大图层的样式。
const ARROW_CLASS = 'top-1/2 -translate-y-1/2 [&_svg]:size-5 hover:border-transparent hover:text-white hover:backdrop-blur-glass';

/** 全屏大图层：点遮罩 / 右上角 / Esc 关闭。
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
  downloadName,
}: {
  src: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  downloadName?: string;
}) {
  const onCloseRef = useRef(onClose);
  const onPreviousRef = useRef(onPrevious);
  const onNextRef = useRef(onNext);
  onCloseRef.current = onClose;
  onPreviousRef.current = onPrevious;
  onNextRef.current = onNext;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
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
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-glass"
      onClick={onClose}
    >
      <img
        src={src}
        alt="大图"
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <Button variant="bare"
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className={`${CONTROL_CLASS} right-6 top-6`}
      >
        <CloseIcon size="lg" />
      </Button>
      {downloadName && (
        <a
          href={src}
          download={downloadName}
          aria-label="下载图片"
          onClick={(e) => e.stopPropagation()}
          className={`${CONTROL_CLASS} right-20 top-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
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
