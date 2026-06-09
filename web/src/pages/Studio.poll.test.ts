import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted 保证 mock fn 在 vi.mock 工厂求值前已初始化（否则触发 "Cannot access before initialization"）。
const { getStudioJob } = vi.hoisted(() => ({ getStudioJob: vi.fn() }));
vi.mock('@/api/studio', () => ({
  getStudioJob,
  // Studio.tsx 顶部还 import 了这些；提供占位 fn 防止模块求值时 undefined 调用。
  createStudioJob: vi.fn(),
  listStudioJobs: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));

import { pollJobUntilTerminal } from './Studio';
import type { Job } from '@/schema/jobs';

function videoJob(status: Job['status']): Job {
  return {
    job_id: 'v1', character_id: '', prompt: '', submitted_at: '', model: '',
    params: {}, seed: null, output_paths: status === 'done' ? ['studio/v1/v1.mp4'] : [],
    status, error: null, kind: 'video', namespace: 'studio',
  };
}

beforeEach(() => { vi.useFakeTimers(); getStudioJob.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('pollJobUntilTerminal', () => {
  it('does not false-timeout a video job past the 120-poll image ceiling', async () => {
    // pending for 150 polls (past old 120 cap), then done — must still resolve done.
    let calls = 0;
    getStudioJob.mockImplementation(async () => {
      calls += 1;
      return calls < 150 ? videoJob('pending') : videoJob('done');
    });
    const onFinal = vi.fn();
    const p = pollJobUntilTerminal('v1', onFinal);
    await vi.advanceTimersByTimeAsync(150 * 5000);
    await p;
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal.mock.calls[0][0].status).toBe('done');
  });
});
