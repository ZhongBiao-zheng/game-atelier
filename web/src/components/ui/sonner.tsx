import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

export { toast } from 'sonner';

/** 提示的挂载点。颜色走主题 token，亮暗自动跟随；需要独立一组提示时传 id，toast 里用 toasterId 对应。 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-center"
      style={{
        '--normal-bg': 'var(--card)',
        '--normal-text': 'var(--foreground)',
        '--normal-border': 'var(--border)',
      } as CSSProperties}
      {...props}
    />
  );
}
