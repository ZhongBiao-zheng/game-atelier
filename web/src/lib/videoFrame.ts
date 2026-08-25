/** 视频首帧抽取（chip / 参考堆叠卡缩略图共用）。
 *
 * PromptInput 的编辑器走命令式 DOM、自带按 objectURL 的组件态缓存，只用 captureVideoFrame；
 * 历史记录（RoundList）声明式渲染用 useVideoFrame，模块级缓存按 URL 去重、跨卡片复用。
 */
import { useEffect, useState } from 'react';

/** 视频首帧 → 小尺寸 dataURL；解码失败或调用方取消时返回 null 退回图标。 */
export function captureVideoFrame(url: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    const finish = (thumb: string | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      video.onloadeddata = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      resolve(thumb);
    };
    const abort = () => finish(null);
    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
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
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

const MAX_FRAME_CACHE_SIZE = 100;
const frameCache = new Map<string, string | null>();

interface FrameTask {
  controller: AbortController;
  promise: Promise<string | null>;
  consumers: number;
}

const inflight = new Map<string, FrameTask>();

function cacheFrame(url: string, thumb: string | null): void {
  frameCache.delete(url);
  frameCache.set(url, thumb);
  if (frameCache.size <= MAX_FRAME_CACHE_SIZE) return;
  const oldest = frameCache.keys().next().value;
  if (oldest) frameCache.delete(oldest);
}

function createFrameTask(url: string): FrameTask {
  const controller = new AbortController();
  const task: FrameTask = {
    controller,
    consumers: 0,
    promise: Promise.resolve(null),
  };
  task.promise = captureVideoFrame(url, controller.signal).then((thumb) => {
    if (!controller.signal.aborted) cacheFrame(url, thumb);
    if (inflight.get(url) === task) inflight.delete(url);
    return thumb;
  });
  inflight.set(url, task);
  return task;
}

function subscribeVideoFrame(url: string, onFrame: (thumb: string | null) => void): () => void {
  if (frameCache.has(url)) {
    onFrame(frameCache.get(url) ?? null);
    return () => {};
  }
  const task = inflight.get(url) ?? createFrameTask(url);
  task.consumers += 1;
  let active = true;
  void task.promise.then((thumb) => {
    if (active) onFrame(thumb);
  });
  return () => {
    active = false;
    task.consumers = Math.max(0, task.consumers - 1);
    if (task.consumers === 0 && inflight.get(url) === task) {
      inflight.delete(url);
      task.controller.abort();
    }
  };
}

export function useVideoFrame(url: string | null, enabled: boolean): string | null {
  const [thumb, setThumb] = useState<string | null>(url ? frameCache.get(url) ?? null : null);
  useEffect(() => {
    setThumb(url ? frameCache.get(url) ?? null : null);
    if (!url || !enabled) return;
    return subscribeVideoFrame(url, setThumb);
  }, [url, enabled]);
  return thumb;
}
