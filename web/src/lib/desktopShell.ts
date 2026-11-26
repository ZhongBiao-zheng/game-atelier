/**
 * 桌面外壳（docs/contracts/desktop-shell.md）。外壳在页面加载前给 <html> 写 data-shell /
 * data-titlebar，并只向本页主框架提供 window.atelierShell.setTheme。拖动窗口由 tokens.css 的
 * app-region 声明交给系统。浏览器里全部是空操作。
 */
import type { Theme } from './theme';

/** 外壳的系统菜单「设置…」等入口：detail.path 是站内路径。 */
export const DESKTOP_NAVIGATE_EVENT = 'atelier:navigate';

type ShellBridge = { setTheme: (theme: Theme) => void; openLog?: () => void; showDownload?: (id: string) => void };

function shell(): ShellBridge | null {
  if (!document.documentElement.dataset.shell) return null;
  return (window as unknown as { atelierShell?: ShellBridge }).atelierShell ?? null;
}

/** 外壳记下页面的深浅色，下次启动的窗口底色与加载页跟着走，浅色用户不再先闪一下暗色。 */
export function syncShellTheme(theme: Theme) {
  shell()?.setTheme(theme);
}

/** 桌面版打开服务日志；浏览器里与旧外壳没有这个接口，返回 null（调用方据此不显示按钮）。 */
export function shellLogOpener(): (() => void) | null {
  const open = shell()?.openLog;
  return open ? () => open() : null;
}

/** 桌面版在访达 / 资源管理器里定位存进「下载」的文件（id 来自下载事件）；浏览器与旧外壳返回 null。 */
export function shellDownloadRevealer(): ((id: string) => void) | null {
  const show = shell()?.showDownload;
  return show ? (id) => show(id) : null;
}

/** 只接受站内路径，避免事件被用来导航到别处。 */
export function desktopNavigatePath(event: Event): string | null {
  const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null;
}
