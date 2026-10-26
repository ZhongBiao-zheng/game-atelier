import { useEffect, useState } from 'react';
import { requestJson } from '@/api/http';

/** Price the current editor intent; never display a result for an older request. */
export function useGenerationEstimate(alias: string | undefined, model: string,
  params: Record<string, unknown>, enabled: boolean): number | null {
  const request = JSON.stringify({ alias, model, kind: 'image', params });
  const [result, setResult] = useState<{ request: string; enabled: boolean; cost: number | null }>(
    { request, enabled, cost: null });
  if (result.request !== request || result.enabled !== enabled) {
    setResult({ request, enabled, cost: null });
  }
  useEffect(() => {
    if (!enabled || !alias || !model) return;
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      requestJson<{ estimated_cost_cny: number | null }>('/api/pricing/estimate', '读取预计费用', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request,
        signal: controller.signal,
      }).then(value => {
        if (active) setResult({ request, enabled, cost: value.estimated_cost_cny });
      }).catch(() => {
        if (active) setResult({ request, enabled, cost: null });
      });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [request, alias, model, enabled]);
  return enabled && result.enabled && result.request === request ? result.cost : null;
}
