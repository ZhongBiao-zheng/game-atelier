import { useState, type CSSProperties, type ReactNode } from 'react';

/** 启动页文案的出现延迟：300ms 内完成的启动一个字都不闪。 */
const STARTUP_LABEL_DELAY_MS = 300;
let startupShownAt: number | null = null;

/** 启动加载页。连接闸门与首启状态读取先后各挂一次，共用这一个外观；文案延迟从第一次出现算起，
 *  第二个挂载点接着播，不重新等 300ms，也不在两页之间闪一帧。 */
export function StartupScreen({ label, children }: { label: string; children?: ReactNode }) {
  const [delay] = useState(() => {
    const now = performance.now();
    startupShownAt ??= now;
    return STARTUP_LABEL_DELAY_MS - (now - startupShownAt);
  });
  return (
    <main data-connection-controls className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <p role="status" className="delayed-reveal font-display text-display italic text-pretty text-muted-foreground"
          style={{ '--reveal-delay': `${Math.round(delay)}ms` } as CSSProperties}>{label}</p>
        {children}
      </div>
    </main>
  );
}
