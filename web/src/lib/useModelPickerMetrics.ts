import { useEffect, useRef, useState } from 'react';
import { requestJson } from '@/api/http';
import { modelModality, type KeyModel, type KeyView } from '@/api/keys';
import type { JobParams } from '@/schema/jobs';

export interface ModelPickerChoice { key: KeyView; model: KeyModel }
type Metrics = Record<string, number | null>;
type Params = Partial<Record<'image' | 'video', JobParams>>;
const DURATION_TTL = 60_000;
let durationCache: { values: Metrics; at: number } | undefined;
let durationRequest: Promise<Metrics> | undefined;
const priceCache = new Map<string, { values?: Metrics; pending?: Promise<Metrics> }>();

function requestKey(choices: ModelPickerChoice[], params: Params) {
  return JSON.stringify((['image', 'video'] as const).map(kind => ({
    kind, params: { ...params[kind], n: 1 },
    items: choices.filter(choice => modelModality(choice.model, choice.key) === kind)
      .map(choice => ({ alias: choice.key.alias, model: choice.model.id })),
  })).filter(batch => batch.items.length));
}

function loadDurations() {
  if (durationCache && Date.now() - durationCache.at < DURATION_TTL) return Promise.resolve(durationCache.values);
  return durationRequest ??= requestJson<Metrics>('/api/models/durations', '读取模型耗时')
    .then(values => { durationCache = { values, at: Date.now() }; return values; })
    .finally(() => { durationRequest = undefined; });
}

function loadPrices(request: string) {
  const cached = priceCache.get(request);
  if (cached?.values) return Promise.resolve(cached.values);
  if (cached?.pending) return cached.pending;
  const pending = Promise.allSettled((JSON.parse(request) as unknown[]).map(batch =>
    requestJson<Metrics>('/api/pricing/estimate-batch', '读取预计费用', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch),
    }),
  )).then(results => {
    const values: Metrics = Object.assign({}, ...results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
    // 某种模态失败时仍展示其余结果，失败请求不缓存，下一次打开可重试。
    if (results.every(result => result.status === 'fulfilled')) priceCache.set(request, { values });
    else priceCache.delete(request);
    return values;
  });
  priceCache.set(request, { pending });
  return pending;
}

export async function prefetchModelPickerMetrics(choices: ModelPickerChoice[], params: Params) {
  await Promise.allSettled([loadDurations(), loadPrices(requestKey(choices, params))]);
}

export function useModelPickerMetrics(choices: ModelPickerChoice[], params: Params) {
  const request = requestKey(choices, params);
  const previousRequest = useRef(request);
  const [durations, setDurations] = useState<Metrics>(() => durationCache?.values ?? {});
  const [prices, setPrices] = useState(() => ({ request, values: priceCache.get(request)?.values ?? {} }));
  useEffect(() => {
    let active = true;
    // 请求由预取和所有菜单共用；单个菜单关闭不能取消其他订阅者的请求。
    void loadDurations().then(values => { if (active) setDurations(values); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    const changed = previousRequest.current !== request;
    previousRequest.current = request;
    const load = () => {
      void loadPrices(request).then(values => {
        if (active) setPrices({ request, values });
      }).catch(() => {});
    };
    const timer = changed && !priceCache.has(request) ? window.setTimeout(load, 300) : undefined;
    if (timer === undefined) load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [request]);
  return { durations, prices: priceCache.get(request)?.values ?? (prices.request === request ? prices.values : {}) };
}
