import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import * as PopoverPrimitive from '@radix-ui/react-popover';

export type ToolbarPopoverDirection = 'up' | 'down';

export interface ToolbarPopoverMenuProps {
  menuDirection?: ToolbarPopoverDirection;
  portalContainerRef?: RefObject<HTMLElement | null>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 触发器（控件 chip 外壳），用于定位；点它不算点到外面。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 优先向上弹还是向下弹；空间不够时自动翻面。 */
  direction?: ToolbarPopoverDirection;
  /** 面板与锚点的横向对齐：start = 左边缘对齐（默认），end = 右边缘对齐。 */
  align?: 'start' | 'end';
  /** 打开后把焦点移入首个交互项；菜单/设置面板启用，富文本建议层保持原输入焦点。 */
  autoFocus?: boolean;
  /** 面板视觉类（宽度 / 圆角 / 背景 / 内边距），不含定位类。 */
  className?: string;
  /** 面板高度上限（px），实际取它与可用高度的较小值。 */
  maxHeight?: number;
  /** 在 Dialog 里使用时 portal 进 Dialog 内容，焦点陷阱才能覆盖面板。 */
  portalContainerRef?: RefObject<HTMLElement | null>;
  role?: string;
  'aria-label'?: string;
  'aria-multiselectable'?: boolean | 'true' | 'false';
  'data-testid'?: string;
  children: ReactNode;
}

const openPopovers = new Set<{ close: () => void; content: () => HTMLElement | null }>();

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 控件 chip 的下拉面板（Radix Popover）。portal 出滚动容器避免被底栏横滚裁剪；
 * 锚点在视口里移动（画布平移、节点浮层改位置）没有事件可听，用 updatePositionStrategy="always" 逐帧跟随。
 */
export function ToolbarPopover({
  open,
  onClose,
  anchorRef,
  direction = 'up',
  align = 'start',
  autoFocus = false,
  className = '',
  maxHeight,
  portalContainerRef,
  children,
  ...rest
}: Props) {
  // 容器 ref 在首帧渲染时还没挂上（父组件的 ref 晚于子组件的 layout effect）：等它就位后再 portal，
  // 否则会落到 body 上、逃出 Dialog 的焦点陷阱。
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => { setContainer(portalContainerRef?.current ?? null); }, [portalContainerRef, open]);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    for (const other of openPopovers) {
      if (!anchorRef.current || !other.content()?.contains(anchorRef.current)) other.close();
    }
    const entry = { close: () => closeRef.current(), content: () => contentRef.current };
    openPopovers.add(entry);
    return () => { openPopovers.delete(entry); };
  }, [open, anchorRef]);
  const waitingForContainer = Boolean(portalContainerRef) && !container;
  const insideAnchor = (target: EventTarget | null) => target instanceof Node && Boolean(anchorRef.current?.contains(target));
  const available = 'var(--radix-popover-content-available-height)';
  const style: CSSProperties = {
    maxWidth: 'var(--radix-popover-content-available-width)',
    maxHeight: maxHeight === undefined ? available : `min(${available}, ${maxHeight}px)`,
    overflow: 'auto',
    overscrollBehavior: 'contain',
  };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <PopoverPrimitive.Anchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      {!waitingForContainer && <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Content
          ref={contentRef}
          data-toolbar-popover=""
          side={direction === 'up' ? 'top' : 'bottom'}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          updatePositionStrategy="always"
          style={style}
          className={cn('z-50', className)}
          onOpenAutoFocus={event => {
            event.preventDefault();
            if (autoFocus) (event.currentTarget as HTMLElement).querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
          }}
          // 关闭后焦点去哪由调用方决定（Esc 回触发器，点外面留在被点处）
          onCloseAutoFocus={event => event.preventDefault()}
          onEscapeKeyDown={() => {
            const anchor = anchorRef.current;
            const trigger = anchor?.matches(FOCUSABLE) ? anchor : anchor?.querySelector<HTMLElement>(FOCUSABLE);
            trigger?.focus();
          }}
          onPointerDownOutside={event => { if (insideAnchor(event.target)) event.preventDefault(); }}
          // 富文本建议层打开时焦点留在输入框里，不能因此关闭
          onFocusOutside={event => event.preventDefault()}
          {...rest}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>}
    </PopoverPrimitive.Root>
  );
}
