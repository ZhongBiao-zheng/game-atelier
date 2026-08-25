import {
  createPortal,
} from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

export type ToolbarPopoverDirection = 'up' | 'down';

export interface ToolbarPopoverMenuProps {
  menuDirection?: ToolbarPopoverDirection;
  portalContainerRef?: RefObject<HTMLElement | null>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 触发器（控件 chip 外壳），用于测量定位。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 向上弹（bottom-full）还是向下弹（top-full）。 */
  direction?: ToolbarPopoverDirection;
  /** 面板与锚点的横向对齐：start = 左边缘对齐（默认），end = 右边缘对齐。
   *  靠屏幕右侧的锚点（顶栏图标钮）必须用 end，否则宽面板会溢出视口。 */
  align?: 'start' | 'end';
  /** 打开后把焦点移入首个交互项；菜单/设置面板启用，富文本建议层保持原输入焦点。 */
  autoFocus?: boolean;
  /** 面板视觉类（宽度 / 圆角 / 背景 / 内边距），不含定位类。 */
  className?: string;
  /** Dialog 的焦点陷阱必须拥有 portaled 面板，否则菜单交互会被 Radix 抢回焦点。 */
  portalContainerRef?: RefObject<HTMLElement | null>;
  role?: string;
  'aria-label'?: string;
  'aria-multiselectable'?: boolean | 'true' | 'false';
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
  align = 'start',
  autoFocus = false,
  className = '',
  portalContainerRef,
  children,
  ...rest
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  /** 是否已经用「面板渲染后的实测宽度」摆过一次（每次开合重置）。 */
  const measured = useRef(false);
  const focused = useRef(false);

  const place = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    // 贴锚点，但两侧都夹在视口内：窄屏下宽面板贴锚点右缘会把左边缘顶出屏幕外
    // （375px 视口实测 left=-104）。宽度要等面板渲染出来才量得到，所以首帧按锚点摆，
    // 面板落地后由下面那个 layout effect 带着实测宽度再摆一次。
    const w = panelRef.current?.offsetWidth ?? 0;
    const clamp = (v: number) => Math.max(GAP, Math.min(v, window.innerWidth - w - GAP));
    const globalX = align === 'end'
      ? window.innerWidth - clamp(window.innerWidth - r.right) - w
      : clamp(r.left);
    const containerRect = portalContainerRef?.current?.getBoundingClientRect();
    if (containerRect) {
      setPos(direction === 'down'
        ? { left: globalX - containerRect.left, top: r.bottom - containerRect.top + GAP }
        : { left: globalX - containerRect.left, bottom: containerRect.bottom - r.top + GAP });
      return;
    }
    const x = align === 'end'
      ? { right: clamp(window.innerWidth - r.right) }
      : { left: globalX };
    setPos(
      direction === 'down'
        ? { ...x, top: r.bottom + GAP }
        : { ...x, bottom: window.innerHeight - r.top + GAP },
    );
  }, [align, anchorRef, direction, portalContainerRef]);

  useLayoutEffect(() => {
    if (!open) {
      measured.current = false;
      focused.current = false;
      return;
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  // 二次定位走 layout effect 而不是 rAF：标签页在后台时 rAF 被节流，面板会卡在首帧
  // 那个没夹紧的位置（本仓在 framer-motion 上踩过同一个节流坑）。
  useLayoutEffect(() => {
    if (!open || pos === null || measured.current || !panelRef.current) return;
    measured.current = true;
    place();
  }, [open, pos, place]);

  useLayoutEffect(() => {
    if (!autoFocus || !open || pos === null || focused.current || !panelRef.current) return;
    const first = panelRef.current.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!first) return;
    focused.current = true;
    first.focus();
  }, [autoFocus, open, pos]);

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

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      const anchor = anchorRef.current;
      const trigger = anchor?.matches('button, [href], input, select, textarea, [tabindex]')
        ? anchor as HTMLElement
        : anchor?.querySelector<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
      trigger?.focus();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      data-toolbar-popover=""
      style={{
        position: portalContainerRef?.current ? 'absolute' : 'fixed',
        left: pos.left,
        right: pos.right,
        top: pos.top,
        bottom: pos.bottom,
        zIndex: 50,
      }}
      className={className}
      {...rest}
    >
      {children}
    </div>,
    portalContainerRef?.current ?? document.body,
  );
}
