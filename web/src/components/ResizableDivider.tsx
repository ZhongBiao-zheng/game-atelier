import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/tooltip';
import { animate, motionAvailable, MOTION_DURATION, MOTION_EASE, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';

interface Props {
  /** 左侧面板当前宽度（px），决定分界线位置 */
  width: number;
  min: number;
  max: number;
  /** 低于此值收起为 0；不传 = 不可收起，只 clamp 到 min */
  snap?: number;
  /** 拖动中实时回调 */
  onResize: (w: number) => void;
  /** 松手定格（持久化时机） */
  onCommit: (w: number) => void;
  label: string;
  className?: string;
}

/**
 * 弹性分界线：常态隐形，hover 亮发丝（--input），拖动中变黄铜（聚焦签名延伸）。
 * 宿主容器必须 relative + grid，且两栏显式钉 grid-column——
 * 左面板收起时若脱离 grid 流，自动放置会把右栏挪进 0px 列（效果稿踩过的坑）。
 */
export function ResizableDivider({ width, min, max, snap, onResize, onCommit, label, className }: Props) {
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  // 指针事件比帧密：一帧只回调一次最新宽度，宿主不会一帧重排好几次。
  const frame = useRef<number | null>(null);
  const scheduled = useRef(false);
  // 跨过吸附阈值（收起成 0 / 从 0 拉出来）时宽度用 200ms 补过去，不一下跳没；补间中继续拖，补完接上最新位置。
  const snapping = useRef<AnimationPlaybackControls | null>(null);
  const shown = useRef(width);
  const latest = useRef(width);
  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    snapping.current?.stop();
  }, []);

  function clamp(x: number): number {
    if (snap !== undefined && x < snap) return 0;
    return Math.round(Math.min(max, Math.max(min, x)));
  }

  function apply(w: number) {
    if (snapping.current) return;
    const crossed = (w === 0) !== (shown.current === 0);
    if (crossed && motionAvailable() && !prefersReducedMotion()) {
      snapping.current = animate(shown.current, w, {
        duration: MOTION_DURATION.base,
        ease: MOTION_EASE.inOut,
        onUpdate: value => { shown.current = value; onResize(Math.round(value)); },
        onComplete: () => {
          snapping.current = null;
          shown.current = w;
          if (latest.current !== w) apply(latest.current);
        },
      });
      return;
    }
    shown.current = w;
    onResize(w);
  }

  function flush() {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    scheduled.current = false;
    apply(latest.current);
  }

  function finish() {
    if (!dragging) return;
    setDragging(false);
    flush();
    onCommit(widthRef.current);
  }

  return (
    <Hint label="拖拽调整布局"><div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      style={{ left: width }}
      className={cn(
        'group absolute inset-y-0 z-20 w-2.5 -translate-x-1/2 cursor-col-resize touch-none',
        className,
      )}
      onPointerDown={e => {
        shown.current = width;
        latest.current = width;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={e => {
        if (!dragging) return;
        const host = e.currentTarget.parentElement;
        if (!host) return;
        const w = clamp(e.clientX - host.getBoundingClientRect().left);
        // 同步记下最新宽度：move 的 setState 是异步批处理，若 pointerup 在同一帧到达，
        // 渲染期赋值的 widthRef 还是旧值，commit 会用旧宽度覆盖刚拖出的新宽度
        widthRef.current = w;
        latest.current = w;
        if (!scheduled.current) {
          scheduled.current = true;
          const id = requestAnimationFrame(flush);
          if (scheduled.current) frame.current = id;
        }
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-1/2 w-px transition-colors duration-150',
          dragging ? 'bg-primary' : 'bg-transparent group-hover:bg-input',
        )}
      />
    </div></Hint>
  );
}
