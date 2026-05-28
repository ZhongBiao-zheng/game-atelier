import { type ReactNode, useEffect, useState } from 'react';

const MIN_WIDTH = 1280;

export function MinViewportGuard({ children }: { children: ReactNode }) {
  const [tooNarrow, setTooNarrow] = useState(
    typeof window !== 'undefined' && window.innerWidth < MIN_WIDTH,
  );
  useEffect(() => {
    const onResize = () => setTooNarrow(window.innerWidth < MIN_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (tooNarrow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="space-y-3">
          <h1 className="italic text-2xl" style={{ fontFamily: 'var(--font-display)' }}>
            Atelier · 工坊
          </h1>
          <p className="text-sm text-muted-foreground">
            请在桌面浏览器打开（≥1280px）。
            <br />
            这是一个本地图像编辑工具，在小屏上不展开。
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
