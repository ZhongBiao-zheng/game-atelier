import { useEffect } from 'react';
import { toast, Toaster } from '@/components/ui/sonner';

/** 桌面外壳在下载落盘后派发（docs/contracts/desktop-shell.md）；浏览器有自己的下载提示，不会收到。 */
export const DESKTOP_DOWNLOAD_EVENT = 'atelier:download-saved';
const TOASTER_ID = 'desktop-download';

export function DesktopDownloadNotice() {
  useEffect(() => {
    const onSaved = (event: Event) => {
      const name = (event as CustomEvent<{ name?: unknown }>).detail?.name;
      toast(typeof name === 'string' && name ? `已保存到「下载」：${name}` : '已保存到「下载」', {
        toasterId: TOASTER_ID,
      });
    };
    window.addEventListener(DESKTOP_DOWNLOAD_EVENT, onSaved);
    return () => window.removeEventListener(DESKTOP_DOWNLOAD_EVENT, onSaved);
  }, []);
  return <Toaster id={TOASTER_ID} />;
}
