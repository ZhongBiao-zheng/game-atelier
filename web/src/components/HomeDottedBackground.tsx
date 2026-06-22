import { useCallback, useEffect, useRef } from 'react';

/**
 * 首页交互波点背景 —— canvas 逐帧绘制，光标处高斯发光 + 冷蓝染色。
 *
 * 手法 1:1 复刻自 tapnow 的 HomeDottedBackground（canvas spotlight）：
 *   22px 网格 / σ=半径÷2 的高斯衰减 / 300px 光斑 / DPR≤2 / 纵向淡出遮罩。
 * 基础点色随主题（--foreground）：暗色前景 ≈ tapnow 的白，与其像素级一致；
 * 亮色降为黑点保证可见。高亮冷蓝 (186,224,255) 固定 —— tapnow 招牌冷光跟随。
 *
 * 取代旧的 CSS 双层 .bg-dots / .bg-dots-glow（阶梯 mask 单色发光）。
 */

const GRID_STEP_PX = 22;
const SPOT_RADIUS_PX = 300;
const MAX_DPR = 2;
const BASE_ALPHA = 0.07;
const HOVER = { r: 186, g: 224, b: 255, a: 0.175 };
const MASK =
  'linear-gradient(to bottom, #000 0%, #000 30%, rgba(0,0,0,0.08) 55%, transparent 70%)';

/** 读 --foreground（hex）→ rgb，让基础点色跟随深浅主题 */
function readForeground(): { r: number; g: number; b: number } {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--foreground')
    .trim()
    .replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const n = Number.parseInt(full || 'ededed', 16);
  if (Number.isNaN(n)) return { r: 237, g: 234, b: 227 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function HomeDottedBackground({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 视口坐标；每帧重算局部坐标，滚动也跟手 */
  const pointerRef = useRef<{ cx: number; cy: number } | null>(null);
  const baseRef = useRef({ r: 237, g: 234, b: 227 });
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = root.clientWidth;
    const cssH = root.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    const pt = pointerRef.current;
    let mx = Number.NEGATIVE_INFINITY;
    let my = Number.NEGATIVE_INFINITY;
    if (pt) {
      const rect = root.getBoundingClientRect();
      const lx = pt.cx - rect.left;
      const ly = pt.cy - rect.top;
      if (lx >= 0 && ly >= 0 && lx <= cssW && ly <= cssH) {
        mx = lx;
        my = ly;
      }
    }

    /** 高斯衰减 exp(-d²/2σ²)，σ≈半径÷2 */
    const sigma2 = (SPOT_RADIUS_PX * SPOT_RADIUS_PX) / 4;
    const base = baseRef.current;

    for (let y = GRID_STEP_PX * 0.5; y < cssH; y += GRID_STEP_PX) {
      for (let x = GRID_STEP_PX * 0.5; x < cssW; x += GRID_STEP_PX) {
        const dx = x - mx;
        const dy = y - my;
        const hl = Math.exp(-((dx * dx + dy * dy) / (2 * sigma2)));

        const r = base.r + (HOVER.r - base.r) * hl;
        const g = base.g + (HOVER.g - base.g) * hl;
        const b = base.b + (HOVER.b - base.b) * hl;
        const a = BASE_ALPHA + (HOVER.a - BASE_ALPHA) * hl;

        ctx.fillStyle = `rgba(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)}, ${a})`;
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
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
    const root = rootRef.current;
    if (!root) return;
    baseRef.current = readForeground();

    // ResizeObserver 在 jsdom（测试）等环境缺失 —— 优雅降级，缺了只是不随容器尺寸重绘
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null;
    ro?.observe(root);
    schedule();

    const onMove = (e: MouseEvent) => {
      const rect = root.getBoundingClientRect();
      const ix = e.clientX - rect.left;
      const iy = e.clientY - rect.top;
      const outside = ix < 0 || iy < 0 || ix > rect.width || iy > rect.height;
      pointerRef.current = outside ? null : { cx: e.clientX, cy: e.clientY };
      schedule();
    };

    /** 深浅主题切换刷新基础点色 */
    const mo = new MutationObserver(() => {
      baseRef.current = readForeground();
      schedule();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });

    return () => {
      ro?.disconnect();
      mo.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [schedule]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={['pointer-events-none absolute inset-0 overflow-hidden', className]
        .filter(Boolean)
        .join(' ')}
      style={{
        WebkitMaskImage: MASK,
        maskImage: MASK,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: '100% 100%',
        maskSize: '100% 100%',
      }}
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
