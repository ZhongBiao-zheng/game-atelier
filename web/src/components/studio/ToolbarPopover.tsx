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
import { toolbarPopoverContainerSpace, toolbarPopoverPosition } from './toolbarPopoverPosition';

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

/**
 * 控件 chip 的下拉面板 —— portal 到 body、按锚点 fixed 定位。
 *
 * 为什么 portal：底栏控件行改成横向滚动后（overflow-x:auto 强制 overflow-y 也裁剪），
 * 内联 absolute 面板会被滚动容器纵向切掉。portal 出去让面板脱离裁剪，定位靠测量锚点
 * getBoundingClientRect：滚动 / resize 时跟随，锚点自己在视口里移动（画布平移、节点浮层
 * 改 left/top）时也跟随 —— 后者没有事件可听，靠逐帧比对锚点 rect。外点关闭在此自理
 * （点锚点与面板内不关）。
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
    left: number;
    top?: number;
    bottom?: number;
    maxWidth: number;
    maxHeight: number;
    direction: ToolbarPopoverDirection;
  } | null>(null);
  const focused = useRef(false);

  const place = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    const panel = panelRef.current;
    const container = portalContainerRef?.current;
    const space = toolbarPopoverContainerSpace(container);
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const placement = toolbarPopoverPosition(a.getBoundingClientRect(), {
      width: (panel?.offsetWidth ?? 0) * space.scaleX,
      // A capped menu must still report its full content height, or it can flip back
      // and forth between sides after its first constrained render.
      height: panel ? (panel.scrollHeight + panel.offsetHeight - panel.clientHeight) * space.scaleY : 0,
    }, {
      left: viewportLeft,
      top: viewportTop,
      right: viewportLeft + (viewport?.width ?? window.innerWidth),
      bottom: viewportTop + (viewport?.height ?? window.innerHeight),
    }, direction, align);
    const top = (placement.top - space.top) / space.scaleY + space.scrollTop;
    const next = {
      left: (placement.left - space.left) / space.scaleX + space.scrollLeft,
      ...(placement.direction === 'down'
        ? { top }
        : { bottom: (container?.clientHeight ?? window.innerHeight) - top - placement.height / space.scaleY }),
      maxWidth: placement.maxWidth / space.scaleX,
      maxHeight: placement.maxHeight / space.scaleY,
      direction: placement.direction,
    };
    setPos(current => current && Object.keys(next).every(key =>
      current[key as keyof typeof next] === next[key as keyof typeof next],
    ) ? current : next);
  }, [align, anchorRef, direction, portalContainerRef]);

  useLayoutEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, place]);

  // 锚点自己在视口里移动时，没有任何事件可以听：画布平移是 xyflow 给 viewport 加 CSS
  // transform，节点浮层面板是父组件改 left / top —— 两者都不触发 scroll / resize，于是
  // 面板走了、这层子弹窗钉在屏幕原地（2026-08-27 画布实测）。所以逐帧比对锚点的视口
  // rect，只在真的变了时重新摆。这是「订阅容器的变化 ≠ 订阅元素的变化」的第二次：
  // 5.31.1 修了面板跟随节点，面板里的子弹窗当时没跟着修。
  //
  // 和下面那条「二次定位不用 rAF」不冲突：那条说的是**首次**摆放不能依赖 rAF（后台标签
  // 页被节流就永远卡在首帧位置）；这里只负责**跟随**，而后台标签页里没有东西在动。
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rectKey = () => {
      const r = anchor.getBoundingClientRect();
      const c = portalContainerRef?.current?.getBoundingClientRect();
      return `${r.left},${r.top},${r.right},${r.bottom},${c?.left},${c?.top},${c?.width},${c?.height}`;
    };
    let last = rectKey();
    let raf = requestAnimationFrame(function tick() {
      const key = rectKey();
      if (key !== last) {
        last = key;
        place();
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, place, anchorRef, portalContainerRef]);

  // 二次定位走 layout effect 而不是 rAF：标签页在后台时 rAF 被节流，面板会卡在首帧
  // 那个没夹紧的位置（本仓在 framer-motion 上踩过同一个节流坑）。
  useLayoutEffect(() => {
    if (open && panelRef.current) place();
  });

  const hasPosition = pos !== null;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    // Observe children too: their height can change while the outer menu is capped
    // (custom size fields, async model lists, or late image/font loading).
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    const observeContent = () => {
      resize?.disconnect();
      resize?.observe(panel);
      for (const child of panel.children) resize?.observe(child);
    };
    observeContent();
    const mutation = new MutationObserver(() => { observeContent(); place(); });
    mutation.observe(panel, { childList: true, subtree: true, characterData: true });
    return () => { resize?.disconnect(); mutation.disconnect(); };
  }, [open, hasPosition, place]);

  useLayoutEffect(() => {
    if (!autoFocus || !open || pos === null || focused.current || !panelRef.current) return;
    const first = panelRef.current.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!first) return;
    focused.current = true;
    first.focus({ preventScroll: true });
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
      data-side={pos.direction}
      style={{
        position: portalContainerRef?.current ? 'absolute' : 'fixed',
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        maxWidth: pos.maxWidth,
        maxHeight: pos.maxHeight,
        minWidth: 0,
        minHeight: 0,
        boxSizing: 'border-box',
        overflow: 'auto',
        overscrollBehavior: 'contain',
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
