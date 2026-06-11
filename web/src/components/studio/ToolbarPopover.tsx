import {
  createPortal,
} from 'react-dom';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 触发器（控件 chip 外壳），用于测量定位。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 向上弹（bottom-full）还是向下弹（top-full）。 */
  direction?: 'up' | 'down';
  /** 面板视觉类（宽度 / 圆角 / 背景 / 内边距），不含定位类。 */
  className?: string;
  role?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  children: ReactNode;
}

const GAP = 12;

/**
 * 控件 chip 的下拉面板 —— portal 到 body、按锚点 fixed 定位。
 *
 * 为什么 portal：底栏控件行改成横向滚动后（overflow-x:auto 强制 overflow-y 也裁剪），
 * 内联 absolute 面板会被滚动容器纵向切掉。portal 出去让面板脱离裁剪，定位靠测量锚点
 * getBoundingClientRect，滚动 / resize 时跟随。外点关闭在此自理（点锚点与面板内不关）。
 */
export function ToolbarPopover({
  open,
  onClose,
  anchorRef,
  direction = 'up',
  className = '',
  children,
  ...rest
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const a = anchorRef.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      if (direction === 'down') {
        setPos({ left: r.left, top: r.bottom + GAP });
      } else {
        setPos({ left: r.left, bottom: window.innerHeight - r.top + GAP });
      }
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, direction, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      data-toolbar-popover=""
      style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, zIndex: 50 }}
      className={className}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}
