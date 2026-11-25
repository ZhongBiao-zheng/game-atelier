import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

export { toast } from 'sonner';

/** 提示的挂载点：全站只挂一个（AppShell），所有 toast 都进这一组。颜色走主题 token，亮暗自动跟随；
 *  进退场时长与曲线由 tokens.css 对齐动效 token。
 *  位置在右上角、顶栏（lg:h-20）下方：避开 Studio 底部输入壳与画布右下的批量结果 / MiniMap。 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="top-right"
      offset={{ top: 96, right: 16 }}
      gap={8}
      expand
      visibleToasts={4}
      style={{
        '--normal-bg': 'var(--card)',
        '--normal-text': 'var(--foreground)',
        '--normal-border': 'var(--border)',
      } as CSSProperties}
      {...props}
    />
  );
}
