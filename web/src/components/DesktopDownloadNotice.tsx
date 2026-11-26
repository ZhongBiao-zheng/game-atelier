import { useEffect } from 'react';
import { toast } from '@/components/ui/sonner';
import { shellDownloadRevealer } from '@/lib/desktopShell';

/** 桌面外壳在下载落盘后派发（docs/contracts/desktop-shell.md）；浏览器有自己的下载提示，不会收到。 */
export const DESKTOP_DOWNLOAD_EVENT = 'atelier:download-saved';

export function DesktopDownloadNotice() {
  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: unknown; id?: unknown }>).detail;
      const name = detail?.name;
      const id = detail?.id;
      const reveal = typeof id === 'string' && id ? shellDownloadRevealer() : null;
      toast(typeof name === 'string' && name ? `已保存到「下载」：${name}` : '已保存到「下载」', reveal
        ? { action: { label: '打开所在文件夹', onClick: () => reveal(id as string) } }
        : undefined);
    };
    window.addEventListener(DESKTOP_DOWNLOAD_EVENT, onSaved);
    return () => window.removeEventListener(DESKTOP_DOWNLOAD_EVENT, onSaved);
  }, []);
  return null;
}
