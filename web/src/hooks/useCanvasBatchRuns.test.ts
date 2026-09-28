import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCanvasBatchRuns } from './useCanvasBatchRuns';
import type { CanvasBatchRun } from '@/schema/canvasBatch';

const listCanvasBatches = vi.hoisted(() => vi.fn<() => Promise<CanvasBatchRun[]>>());
vi.mock('@/api/canvasBatch', () => ({ listCanvasBatches }));
vi.mock('@/api/canvas', () => ({
  getCanvasDocument: vi.fn(async () => ({ nodes: [], edges: [], versions: [] })),
  listCanvasJobs: vi.fn(async () => []),
}));

function run(status: CanvasBatchRun['status'], error: string | null = null): CanvasBatchRun {
  return {
    batch_id: 'b1', title: '批量', scope_node_id: 'image', status, error,
    steps: [], executions: [], created_at: '2026-09-25T00:00:00Z',
  } as unknown as CanvasBatchRun;
}

async function pollOnceMore(trigger: () => void) {
  const before = listCanvasBatches.mock.calls.length;
  await act(async () => { trigger(); });
  await waitFor(() => expect(listCanvasBatches.mock.calls.length).toBeGreaterThan(before));
  await act(async () => undefined);
}

afterEach(() => { listCanvasBatches.mockReset(); });

describe('useCanvasBatchRuns', () => {
  it('reports the plan-level error once when a watched batch stops being active', async () => {
    const onError = vi.fn();
    listCanvasBatches.mockResolvedValue([run('running')]);
    const { result } = renderHook(() => useCanvasBatchRuns('p', vi.fn(), vi.fn(), onError));
    await waitFor(() => expect(result.current.active?.status).toBe('running'));
    expect(onError).not.toHaveBeenCalled();

    listCanvasBatches.mockResolvedValue([run('failed', '模型配置已改变，请重新确认后执行')]);
    await pollOnceMore(() => result.current.acceptRun(run('running')));
    await waitFor(() => expect(result.current.active).toBeUndefined());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('模型配置已改变，请重新确认后执行');

    await pollOnceMore(() => result.current.acceptRun(run('failed', '模型配置已改变，请重新确认后执行')));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a batch that already ended before the page loaded and for cancels', async () => {
    const onError = vi.fn();
    listCanvasBatches.mockResolvedValue([run('interrupted', '服务已重启')]);
    const { result } = renderHook(() => useCanvasBatchRuns('p', vi.fn(), vi.fn(), onError));
    await waitFor(() => expect(listCanvasBatches).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current.active).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();

    listCanvasBatches.mockResolvedValue([run('running')]);
    await pollOnceMore(() => result.current.acceptRun(run('running')));
    await waitFor(() => expect(result.current.active?.status).toBe('running'));
    listCanvasBatches.mockResolvedValue([run('canceled')]);
    await pollOnceMore(() => result.current.acceptRun(run('canceled')));
    await waitFor(() => expect(result.current.active).toBeUndefined());
    expect(onError).not.toHaveBeenCalled();
  });
});
