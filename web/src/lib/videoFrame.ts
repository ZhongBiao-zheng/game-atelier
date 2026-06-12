/** 视频首帧抽取（chip / 参考堆叠卡缩略图共用）。
 *
 * PromptInput 的编辑器走命令式 DOM、自带按 objectURL 的组件态缓存，只用 captureVideoFrame；
 * 历史记录（RoundList）声明式渲染用 useVideoFrame，模块级缓存按 URL 去重、跨卡片复用。
 */
import { useEffect, useState } from 'react';

/** 视频首帧 → 小尺寸 dataURL；解码失败返回 null 退回图标。 */
export function captureVideoFrame(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.onloadeddata = () => {
      try {
        const w = 96;
        const h = video.videoWidth ? Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w)) : 54;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        resolve(null);
      }
    };
    video.onerror = () => resolve(null);
    video.src = url;
  });
}

const frameCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function getVideoFrame(url: string): Promise<string | null> {
  if (frameCache.has(url)) return Promise.resolve(frameCache.get(url) ?? null);
  let p = inflight.get(url);
  if (!p) {
    p = captureVideoFrame(url).then((thumb) => {
      frameCache.set(url, thumb);
      inflight.delete(url);
      return thumb;
    });
    inflight.set(url, p);
  }
  return p;
}

export function useVideoFrame(url: string | null): string | null {
  const [thumb, setThumb] = useState<string | null>(url ? frameCache.get(url) ?? null : null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void getVideoFrame(url).then((t) => {
      if (alive) setThumb(t);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return thumb;
}
