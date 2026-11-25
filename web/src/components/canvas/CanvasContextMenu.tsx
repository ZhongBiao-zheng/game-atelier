import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type CanvasContextMenuItem =
  | 'separator'
  | {
    key: string;
    label: string;
    icon: React.ReactNode;
    /** 菜单项右侧的快捷键提示。 */
    shortcut?: string;
    disabled?: boolean;
    destructive?: boolean;
    /** 有 href 时是下载链接。 */
    href?: string;
    onSelect?: () => void;
  };

const MENU_MARGIN = 8;

/** 画布与节点的右键菜单：在指针处弹出，点外面、按 Esc、选中一项都会关掉；方向键在项之间移动。 */
export function CanvasContextMenu({ x, y, label, items, onClose }: {
  x: number;
  y: number;
  label: string;
  items: readonly CanvasContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  // 贴着视口边缘时往回收，整块菜单都留在屏幕里。
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - width - MENU_MARGIN)),
      top: Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - height - MENU_MARGIN)),
    });
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  function navigate(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const entries = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    if (!entries.length) return;
    event.preventDefault();
    const current = entries.indexOf(window.document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? entries.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % entries.length
          : (current - 1 + entries.length) % entries.length;
    entries[next]?.focus();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={navigate}
      onContextMenu={event => event.preventDefault()}
      className="fixed z-50 min-w-48 rounded-xl border border-border bg-popover p-1 shell-glow"
      style={position}
    >
      {items.map((item, index) => {
        if (item === 'separator') return <div key={`separator-${index}`} role="separator" className="my-1 h-px bg-border" />;
        const content = <>
          <span aria-hidden="true" className="[&_svg]:size-4">{item.icon}</span>
          <span>{item.label}</span>
          {item.shortcut && <span aria-hidden="true" className="ml-auto pl-4 font-mono text-xs text-muted-foreground">{item.shortcut}</span>}
        </>;
        const className = cn('h-8 w-full justify-start gap-2 px-2 font-normal', item.destructive && 'text-destructive hover:text-destructive');
        return item.href ? (
          <Button key={item.key} asChild variant="ghost" size="sm" className={className}>
            <a role="menuitem" href={item.href} onClick={onClose}>{content}</a>
          </Button>
        ) : (
          <Button
            key={item.key}
            role="menuitem"
            variant="ghost"
            size="sm"
            disabled={item.disabled}
            className={className}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {content}
          </Button>
        );
      })}
    </div>
  );
}
