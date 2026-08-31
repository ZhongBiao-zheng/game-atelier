import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSSE } from './useSSE';

const state = vi.hoisted(() => ({ phase: 'ready', generation: 1, editing: true, message: null }));
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/api/connection', () => ({ connectionFetch: transport, useConnectionState: () => state }));

function events() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  transport.mockResolvedValue(new Response(new ReadableStream({ start(output) { writer = output; }, cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } }));
  return { emit: (value: string) => writer.enqueue(new TextEncoder().encode(value)), cancelled };
}
afterEach(() => { transport.mockReset(); state.phase = 'ready'; state.generation = 1; vi.useRealTimers(); });

describe('useSSE', () => {
  it('uses authenticated fetch and passes complete job payloads', async () => {
    const source = events(); const onJobChanged = vi.fn(); const onConnect = vi.fn();
    const { result } = renderHook(() => useSSE({ onJobChanged, onConnect }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith('/events', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => source.emit('event: job-changed\ndata: {"job_id":"j1","status":"done"}\n\n'));
    expect(onJobChanged).toHaveBeenCalledWith({ job_id: 'j1', status: 'done' }); expect(result.current).toBe(2);
  });
  it('invalidates on malformed payload without forwarding broken JSON', async () => {
    const source = events(); const onJobChanged = vi.fn(); const onConnect = vi.fn();
    const { result } = renderHook(() => useSSE({ onJobChanged, onConnect }));
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    await act(async () => source.emit('event: job-changed\ndata: {half-written\n\n'));
    expect(onJobChanged).not.toHaveBeenCalled(); expect(result.current).toBe(2);
  });
  it('does not connect while disabled or disconnected', () => {
    renderHook(() => useSSE({ enabled: false })); state.phase = 'interrupted'; renderHook(() => useSSE());
    expect(transport).not.toHaveBeenCalled();
  });
  it('aborts the stream when the connection generation changes', async () => {
    const source = events(); const onConnect = vi.fn();
    const { rerender } = renderHook(() => useSSE({ onConnect }));
    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    const signal = transport.mock.calls[0][1].signal;
    state.generation += 1; state.phase = 'interrupted'; rerender(); expect(signal.aborted).toBe(true);
    await waitFor(() => expect(source.cancelled).toHaveBeenCalled()); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('clears reconnect timers on unmount', async () => {
    vi.useFakeTimers(); transport.mockRejectedValue(new Error('offline'));
    const { unmount } = renderHook(() => useSSE()); await act(async () => {}); unmount();
    await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(transport).toHaveBeenCalledTimes(1);
  });
});
