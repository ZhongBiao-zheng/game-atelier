import { useEffect } from 'react';
import { notify } from '@/lib/notify';
import { shellDownloadRevealer } from '@/lib/desktopShell';

/** 桌面外壳在下载落盘后派发（docs/contracts/desktop-shell.md）；浏览器有自己的下载提示，不会收到。 */
export const DESKTOP_DOWNLOAD_EVENT = 'atelier:download-saved';

export function DesktopDownloadNotice() {
  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: unknown; id?: unknown }>).detail;
      const name = typeof detail?.name === 'string' && detail.name ? detail.name : undefined;
      const id = typeof detail?.id === 'string' && detail.id ? detail.id : undefined;
      const reveal = id ? shellDownloadRevealer() : null;
      // 文件名放副文本：长名字不挤占标题，动作按钮也不被顶到第二行。
      notify.info('已保存到「下载」', {
        detail: name,
        action: reveal && id ? { label: '打开所在文件夹', onClick: () => reveal(id) } : undefined,
      });
    };
    window.addEventListener(DESKTOP_DOWNLOAD_EVENT, onSaved);
    return () => window.removeEventListener(DESKTOP_DOWNLOAD_EVENT, onSaved);
  }, []);
  return null;
}
