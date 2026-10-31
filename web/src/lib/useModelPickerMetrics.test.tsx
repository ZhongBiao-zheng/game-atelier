import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';

const requestJson = vi.hoisted(() => vi.fn());
vi.mock('@/api/http', () => ({ requestJson }));
const key = { alias: 'test', provider: 'openai', models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }] } as KeyView;
const choices = [{ key, model: key.models[0] }];
const params = { image: { quality: 'low' } };
const durationValues = { 'test:gpt-image-2': 12 };
const priceValues = { 'test:gpt-image-2': 0.25 };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  requestJson.mockReset().mockImplementation((url: string) => Promise.resolve(url.includes('durations') ? durationValues : priceValues));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function module() { return import('./useModelPickerMetrics'); }

describe('模型菜单指标缓存', () => {
  it('预取完成后第一次 render 同步得到标签数据', async () => {
    const { prefetchModelPickerMetrics, useModelPickerMetrics } = await module();
    await prefetchModelPickerMetrics(choices, params);
    const renders: unknown[] = [];
    const view = renderHook(() => {
      const values = useModelPickerMetrics(choices, params);
      renders.push(values);
      return values;
    });
    expect(renders[0]).toEqual({ durations: durationValues, prices: priceValues });
    await act(async () => {});
    expect(requestJson).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('无缓存首次打开在 0ms 立即请求，重开同步复用数据', async () => {
    const { useModelPickerMetrics } = await module();
    const first = renderHook(() => useModelPickerMetrics(choices, params));
    expect(requestJson).toHaveBeenCalledTimes(2);
    await act(async () => {});
    first.unmount();
    const renders: unknown[] = [];
    renderHook(() => { const value = useModelPickerMetrics(choices, params); renders.push(value); return value; });
    expect(renders[0]).toEqual({ durations: durationValues, prices: priceValues });
    await act(async () => {});
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('打开期间只有请求参数改变才防抖，等价的新引用不会重新请求', async () => {
    const { useModelPickerMetrics } = await module();
    const view = renderHook(({ quality }) => useModelPickerMetrics([...choices], { image: { quality } }), { initialProps: { quality: 'low' } });
    await act(async () => {});
    view.rerender({ quality: 'low' });
    expect(requestJson).toHaveBeenCalledTimes(2);
    view.rerender({ quality: 'high' });
    expect(requestJson).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(299); });
    expect(requestJson).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(requestJson).toHaveBeenCalledTimes(3);
  });

  it('预取与挂载共用进行中的请求，关闭菜单不取消预取', async () => {
    const { prefetchModelPickerMetrics, useModelPickerMetrics } = await module();
    let finish!: (value: typeof durationValues) => void;
    const pending = new Promise<typeof durationValues>(resolve => { finish = resolve; });
    requestJson.mockReturnValue(pending);
    const prefetch = prefetchModelPickerMetrics(choices, params);
    const view = renderHook(() => useModelPickerMetrics(choices, params));
    view.unmount();
    const secondPrefetch = prefetchModelPickerMetrics(choices, params);
    expect(requestJson).toHaveBeenCalledTimes(2);
    finish(durationValues);
    await Promise.all([prefetch, secondPrefetch]);
    renderHook(() => useModelPickerMetrics(choices, params));
    await act(async () => {});
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('耗时超过 60 秒后用旧值首屏展示并后台更新', async () => {
    const { prefetchModelPickerMetrics, useModelPickerMetrics } = await module();
    await prefetchModelPickerMetrics(choices, params);
    vi.advanceTimersByTime(60_001);
    const renders: unknown[] = [];
    renderHook(() => { const value = useModelPickerMetrics(choices, params); renders.push(value); return value; });
    expect(renders[0]).toEqual({ durations: durationValues, prices: priceValues });
    await act(async () => {});
    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requestJson.mock.calls.filter(([url]) => url.includes('durations'))).toHaveLength(2);
  });
  it('某个模态失败仍显示成功模态，重开可重试失败请求', async () => {
    const { useModelPickerMetrics } = await module();
    const mixed = [...choices, { key, model: { id: 'seedance-2', name: 'Seedance', modality: 'video' as const } }];
    requestJson.mockImplementation((url: string, _label: string, options?: RequestInit) =>
      url.includes('durations') ? Promise.resolve(durationValues)
        : JSON.parse(String(options?.body)).kind === 'video' ? Promise.reject(new Error('offline')) : Promise.resolve(priceValues));
    const first = renderHook(() => useModelPickerMetrics(mixed, params));
    await act(async () => {});
    expect(first.result.current.prices).toEqual(priceValues);
    first.unmount();
    renderHook(() => useModelPickerMetrics(mixed, params));
    await act(async () => {});
    expect(requestJson).toHaveBeenCalledTimes(5);
  });

});
