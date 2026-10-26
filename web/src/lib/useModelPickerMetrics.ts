import { useEffect, useState } from 'react';
import { requestJson } from '@/api/http';
import { modelModality, type KeyModel, type KeyView } from '@/api/keys';
import type { JobParams } from '@/schema/jobs';

export interface ModelPickerChoice { key: KeyView; model: KeyModel }
type Metrics = Record<string, number | null>;
export function useModelPickerMetrics(choices: ModelPickerChoice[], params: Partial<Record<'image' | 'video', JobParams>>) {
  const request = JSON.stringify((['image', 'video'] as const).map(kind => ({
    kind, params: { ...params[kind], n: 1 },
    items: choices.filter(choice => modelModality(choice.model, choice.key) === kind)
      .map(choice => ({ alias: choice.key.alias, model: choice.model.id })),
  })).filter(batch => batch.items.length));
  const [durations, setDurations] = useState<Metrics>({});
  const [prices, setPrices] = useState<{ request: string; values: Metrics }>({ request: '', values: {} });
  useEffect(() => {
    const controller = new AbortController();
    requestJson<Metrics>('/api/models/durations', '读取模型耗时', { signal: controller.signal })
      .then(setDurations).catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => {
      Promise.all((JSON.parse(request) as unknown[]).map(batch =>
        requestJson<Metrics>('/api/pricing/estimate-batch', '读取预计费用', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch), signal: controller.signal,
        }).catch(() => ({})),
      )).then(results => {
        if (active) setPrices({ request, values: Object.assign({}, ...results) });
      });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [request]);
  return { durations, prices: prices.request === request ? prices.values : {} };
}
