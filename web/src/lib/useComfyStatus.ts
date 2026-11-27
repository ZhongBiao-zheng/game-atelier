import { useCallback, useEffect, useRef, useState } from 'react';
import { checkComfyUI } from '@/api/comfyui';
import type { KeyModel, KeyView } from '@/api/keys';
import { isAutoProvider } from '@/lib/modelRoutes';

export type ComfyStatus = 'checking' | 'running' | 'stopped';

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';

export function normalizeComfyUrl(baseUrl?: string | null): string {
  return baseUrl?.trim() || DEFAULT_COMFY_URL;
}

/** 仅返回本机直连 ComfyUI 的地址；局域网网关（atelier）转发的远程工作流返回 null。 */
export function localComfyUrl(key: KeyView | undefined, model: KeyModel | undefined): string | null {
  if (!key || !model) return null;
  if (key.provider === 'comfyui') return normalizeComfyUrl(key.base_url);
  if (isAutoProvider(key)) {
    const first = model.members?.[0];
    if (first?.provider === 'comfyui') return normalizeComfyUrl(first.base_url);
  }
  return null;
}

/** 并行探测多个本机 ComfyUI 地址的运行状态；窗口回到前台时静默重检（不闪回检查中）。 */
export function useComfyStatuses(urls: readonly string[]): {
  statuses: Record<string, ComfyStatus>;
  recheck: () => void;
} {
  const uniqueKey = [...new Set(urls.filter(Boolean))].sort().join('\n');
  const [statuses, setStatuses] = useState<Record<string, ComfyStatus>>({});
  const runId = useRef(0);

  const probe = useCallback((silent: boolean) => {
    const targets = uniqueKey ? uniqueKey.split('\n') : [];
    const run = ++runId.current;
    if (!targets.length) {
      setStatuses({});
      return;
    }
    if (!silent) {
      setStatuses(current => {
        const next: Record<string, ComfyStatus> = {};
        for (const url of targets) next[url] = current[url] ?? 'checking';
        return next;
      });
    }
    for (const url of targets) {
      checkComfyUI(url).then(
        () => {
          if (run !== runId.current) return;
          setStatuses(current => (current[url] === 'running' ? current : { ...current, [url]: 'running' }));
        },
        () => {
          if (run !== runId.current) return;
          setStatuses(current => (current[url] === 'stopped' ? current : { ...current, [url]: 'stopped' }));
        },
      );
    }
  }, [uniqueKey]);

  useEffect(() => {
    probe(false);
    if (!uniqueKey) return;
    const onResume = () => {
      if (document.visibilityState !== 'hidden') probe(true);
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      runId.current += 1;
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [probe, uniqueKey]);

  return { statuses, recheck: () => probe(true) };
}

/** 探测单个本机 ComfyUI 地址的运行状态；传入 null 时不发起请求。 */
export function useComfyStatus(url: string | null | undefined): {
  status: ComfyStatus | null;
  recheck: () => void;
} {
  const { statuses, recheck } = useComfyStatuses(url ? [url] : []);
  return { status: url ? (statuses[url] ?? 'checking') : null, recheck };
}
