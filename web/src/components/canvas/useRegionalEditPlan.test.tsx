import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewCanvasEdit } from '@/api/canvas';
import { useRegionalEditPlan } from './useRegionalEditPlan';

vi.mock('@/api/canvas', () => ({ previewCanvasEdit: vi.fn() }));
vi.mock('./imageEditGeometry', () => ({ editMaskBlob: vi.fn(async () => new Blob(['mask'])) }));
const input = { enabled: true, projectId: 'p', nodeId: 'n', versionId: 'v', alias: 'a', model: 'gpt-image-2',
  width: 1024, height: 1024, strokes: [{ tool: 'brush' as const, size: 20, points: [{ x: 10, y: 10 }] }],
  context: .25, feather: null, groups: null };

describe('regional preview freshness', () => {
  afterEach(() => vi.clearAllMocks());
  it('invalidates an old plan immediately and ignores late replies', async () => {
    let finish!: (value: { plan_id: string; regions: [] }) => void;
    vi.mocked(previewCanvasEdit).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(props => useRegionalEditPlan(props), { initialProps: input });
    await waitFor(() => expect(previewCanvasEdit).toHaveBeenCalledOnce());
    vi.mocked(previewCanvasEdit).mockResolvedValueOnce({ plan_id: 'new', regions: [] });
    rerender({ ...input, context: .5 });
    await act(async () => { finish({ plan_id: 'old', regions: [] }); });
    expect(result.current.plan).toBeUndefined();
    await waitFor(() => expect(result.current.plan?.plan_id).toBe('new'));
    rerender({ ...input, context: .75 });
    expect(result.current.plan).toBeUndefined();
    expect(result.current.planning).toBe(true);
  });
  it('does not plan native MJ or expansion and surfaces planning errors', async () => {
    vi.mocked(previewCanvasEdit).mockRejectedValue(new Error('选区为空'));
    const { result, rerender } = renderHook(props => useRegionalEditPlan(props), { initialProps: { ...input, enabled: false } });
    expect(previewCanvasEdit).not.toHaveBeenCalled();
    rerender(input);
    await waitFor(() => expect(result.current.error).toBe('选区为空'));
    expect(result.current.plan).toBeUndefined();
  });
});
