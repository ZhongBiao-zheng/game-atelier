type Rect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
type Direction = 'up' | 'down';

const GAP = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** All inputs and outputs use viewport pixels, including transformed portal containers. */
export function toolbarPopoverPosition(
  anchor: Rect,
  menu: { width: number; height: number },
  viewport: Rect,
  preferred: Direction,
  align: 'start' | 'end',
) {
  const leftEdge = viewport.left + GAP;
  const topEdge = viewport.top + GAP;
  const maxWidth = Math.max(0, viewport.right - leftEdge - GAP);
  const viewportHeight = Math.max(0, viewport.bottom - topEdge - GAP);
  const bottomEdge = topEdge + viewportHeight;
  const space = {
    up: clamp(anchor.top - GAP - topEdge, 0, viewportHeight),
    down: clamp(bottomEdge - anchor.bottom - GAP, 0, viewportHeight),
  };
  const other = preferred === 'up' ? 'down' : 'up';
  const direction = menu.height <= space[preferred] || space[preferred] >= space[other]
    ? preferred
    : other;
  const maxHeight = space[direction];
  const height = Math.min(menu.height, maxHeight);
  const width = Math.min(menu.width, maxWidth);
  return {
    direction,
    left: clamp(align === 'end' ? anchor.right - width : anchor.left, leftEdge, leftEdge + maxWidth - width),
    top: clamp(direction === 'up' ? anchor.top - GAP - height : anchor.bottom + GAP, topEdge, bottomEdge - height),
    height,
    maxWidth,
    maxHeight,
  };
}

/** Absolute children start at the container's padding edge, not its outer border. */
export function toolbarPopoverContainerSpace(container?: HTMLElement | null) {
  const rect = container?.getBoundingClientRect();
  const scaleX = container && rect && container.offsetWidth ? rect.width / container.offsetWidth : 1;
  const scaleY = container && rect && container.offsetHeight ? rect.height / container.offsetHeight : 1;
  return {
    scaleX: scaleX || 1,
    scaleY: scaleY || 1,
    left: rect ? rect.left + container!.clientLeft * scaleX : 0,
    top: rect ? rect.top + container!.clientTop * scaleY : 0,
    scrollLeft: container?.scrollLeft ?? 0,
    scrollTop: container?.scrollTop ?? 0,
  };
}
