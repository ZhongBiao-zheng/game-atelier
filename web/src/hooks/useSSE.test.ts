import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useSSE, type JobChangedPayload } from './useSSE';

class TestEventSource {
  static instances: TestEventSource[] = [];
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    TestEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  close() {}
  emit(type: string, data: string) {
    this.listeners.get(type)?.forEach((cb) => cb({ data } as MessageEvent));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestEventSource.instances = [];
});

describe('useSSE', () => {
  it('passes the job-changed payload to onJobChanged instead of discarding it', () => {
    vi.stubGlobal('EventSource', TestEventSource);
    const received: JobChangedPayload[] = [];
    const { result } = renderHook(() => useSSE({ onJobChanged: (d) => received.push(d) }));

    const es = TestEventSource.instances[0];
    act(() => {
      es.emit('job-changed', JSON.stringify({ job_id: 'j1', status: 'done' }));
    });

    expect(received).toEqual([{ job_id: 'j1', status: 'done' }]);
    expect(result.current).toBe(1); // signal 仍然 bump，老消费方不受影响
  });

  it('swallows a bad payload without breaking the signal', () => {
    vi.stubGlobal('EventSource', TestEventSource);
    const onJobChanged = vi.fn();
    const { result } = renderHook(() => useSSE({ onJobChanged }));

    act(() => {
      TestEventSource.instances[0].emit('job-changed', '{half-written');
    });

    expect(onJobChanged).not.toHaveBeenCalled();
    expect(result.current).toBe(1);
  });

  it('invokes onConnect on open (full-refresh fallback for missed events)', () => {
    vi.stubGlobal('EventSource', TestEventSource);
    const onConnect = vi.fn();
    renderHook(() => useSSE({ onConnect }));

    act(() => {
      TestEventSource.instances[0].onopen?.();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('does not connect when disabled', () => {
    vi.stubGlobal('EventSource', TestEventSource);
    renderHook(() => useSSE({ enabled: false }));
    expect(TestEventSource.instances).toHaveLength(0);
  });
});
