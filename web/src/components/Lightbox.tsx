import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** 全屏大图层：点遮罩 / 右上角 / Esc 关闭。
 *
 * portal 到 body 是硬要求，不是洁癖：`backdrop-filter` 会给 fixed 后代造一个 containing block，
 * 挂在输入壳（bg-glass backdrop-blur-glass）里的 fixed inset-0 会缩到壳那一小条里。
 * 首页/工坊那两处原本就在顶层，portal 对它们无副作用。
 */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
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
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute right-6 top-6 size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-background/90 backdrop-blur-glass border-0"
      >
        <X className="size-5" />
      </button>
    </div>,
    document.body,
  );
}
