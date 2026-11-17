/**
 * 桌面外壳（docs/contracts/desktop-shell.md）。外壳在页面加载前给 <html> 写 data-shell /
 * data-titlebar；页面只能调用拖动窗口、双击缩放、设置窗口深浅色三条命令。浏览器里全部是空操作。
 */
import type { Theme } from './theme';

/** 外壳的系统菜单「设置…」等入口：detail.path 是站内路径。 */
export const DESKTOP_NAVIGATE_EVENT = 'atelier:navigate';

type ShellInternals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

function shell(): ShellInternals | null {
  if (!document.documentElement.dataset.shell) return null;
  return (window as unknown as { __TAURI_INTERNALS__?: ShellInternals }).__TAURI_INTERNALS__ ?? null;
}

/** 外壳记下页面的深浅色，下次启动的窗口底色与加载页跟着走，浅色用户不再先闪一下暗色。 */
export function syncShellTheme(theme: Theme) {
  shell()?.invoke('plugin:window|set_theme', { value: theme }).catch(() => undefined);
}

/** 只接受站内路径，避免事件被用来导航到别处。 */
export function desktopNavigatePath(event: Event): string | null {
  const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null;
}
