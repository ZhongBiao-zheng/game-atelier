import { useCallback, useEffect, useRef } from 'react';

/**
 * 首页交互波点背景：铺满整页（含作品墙），跟内容一起滚动。
 *
 * 两层：
 *   - 底层波点：tokens.css 的 .home-dots（CSS 平铺，22px 网格 / 1px 半径 / 前景色 7%），
 *     页面多高就铺多高，不受 canvas 尺寸上限影响。
 *   - 光斑：一块跟随光标的 canvas，只画光标附近的点，按高斯衰减 exp(-d²/2σ²)（σ = 300÷2）
 *     叠一层冷蓝 (186,224,255)，峰值不透明度 0.175。网格与底层对齐（点心在 11 + 22k）。
 */

const GRID_STEP_PX = 22;
const SPOT_RADIUS_PX = 300;
/** 3σ 之外的贡献 < 1.2%，光斑 canvas 只覆盖这个范围 */
const SPOT_REACH_PX = Math.round(SPOT_RADIUS_PX * 1.5);
const SPOT_SIZE_PX = SPOT_REACH_PX * 2;
const MAX_DPR = 2;
const HOVER = { r: 186, g: 224, b: 255, a: 0.175 };

export function HomeDottedBackground({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 视口坐标；每帧换算成页面内坐标，滚动时光斑仍对准光标 */
  const pointerRef = useRef<{ cx: number; cy: number } | null>(null);
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const pt = pointerRef.current;
    const rect = root.getBoundingClientRect();
    const mx = pt ? pt.cx - rect.left : -1;
    const my = pt ? pt.cy - rect.top : -1;
    // 指针离开 / 回来时光斑 150ms 淡出淡入（tokens 过渡），不是一下有一下没。
    if (!pt || mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
      canvas.style.opacity = '0';
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const px = Math.floor(SPOT_SIZE_PX * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const x0 = mx - SPOT_REACH_PX;
    const y0 = my - SPOT_REACH_PX;
    canvas.style.transform = `translate(${x0}px, ${y0}px)`;
    canvas.style.opacity = '1';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SPOT_SIZE_PX, SPOT_SIZE_PX);

    const sigma2 = (SPOT_RADIUS_PX * SPOT_RADIUS_PX) / 4;
    const half = GRID_STEP_PX / 2;
    const firstX = half + Math.ceil((x0 - half) / GRID_STEP_PX) * GRID_STEP_PX;
    const firstY = half + Math.ceil((y0 - half) / GRID_STEP_PX) * GRID_STEP_PX;

    for (let y = firstY; y < y0 + SPOT_SIZE_PX; y += GRID_STEP_PX) {
      for (let x = firstX; x < x0 + SPOT_SIZE_PX; x += GRID_STEP_PX) {
        const dx = x - mx;
        const dy = y - my;
        const hl = Math.exp(-((dx * dx + dy * dy) / (2 * sigma2)));
        if (hl < 0.01) continue;
        ctx.fillStyle = `rgba(${HOVER.r}, ${HOVER.g}, ${HOVER.b}, ${(HOVER.a * hl).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x - x0, y - y0, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      pointerRef.current = { cx: e.clientX, cy: e.clientY };
      schedule();
    };
    const onLeave = () => {
      pointerRef.current = null;
      schedule();
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeave);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [schedule]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={['home-dots pointer-events-none absolute inset-0 overflow-hidden', className]
        .filter(Boolean)
        .join(' ')}
    >
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 opacity-0 transition-opacity duration-150"
        style={{ width: SPOT_SIZE_PX, height: SPOT_SIZE_PX }}
      />
    </div>
  );
}
