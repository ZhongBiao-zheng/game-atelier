import { expect, it } from 'vitest';

import { presentCanvasCandidates } from './canvasCandidates';
import type { Job } from '@/schema/jobs';

function job(
  jobId: string,
  submittedAt: string,
  candidates: NonNullable<Job['canvas_run']>['candidates'],
): Job {
  return {
    job_id: jobId,
    character_id: 'key',
    prompt: 'prompt',
    submitted_at: submittedAt,
    model: 'model',
    params: { n: candidates.length },
    output_paths: [],
    status: 'partial',
    error: null,
    namespace: 'canvas',
    canvas_project_id: 'canvas-test',
    canvas_run: {
      run_id: `run-${jobId}`,
      result_node_id: 'image-result',
      snapshot: {
        snapshot_version: 1,
        surface_node_id: 'config',
        result_node_id: 'image-result',
        mode: 'image',
        final_prompt: 'prompt',
        input_policy: 'all_connected',
        model: 'model',
        provider: 'openai',
        alias: 'key',
        normalized_params: {},
        inputs: [],
        mask_version_id: null,
        submitted_at: submittedAt,
        submitted_by: { kind: 'user', actor_id: null },
        request_fingerprint: 'a'.repeat(64),
      },
      candidates,
    },
  };
}

it('overlays every slot of a whole-batch retry and pushes the superseded run into history', () => {
  const original = job('original', '2026-08-25T00:00:00Z', [
    { candidate_id: 'slot-0', index: 0, status: 'succeeded', version_id: 'version-0', error: null },
    { candidate_id: 'slot-1', index: 1, status: 'failed', version_id: null, error: 'failed' },
  ]);
  const retry = job('retry', '2026-08-25T00:01:00Z', [
    { candidate_id: 'slot-0-retry', index: 0, status: 'pending', version_id: null, error: null },
    { candidate_id: 'slot-1-retry', index: 1, status: 'pending', version_id: null, error: null },
  ]);

  const presentation = presentCanvasCandidates([original, retry]);

  expect(presentation.current.map(entry => entry.candidate.candidate_id)).toEqual([
    'slot-0-retry',
    'slot-1-retry',
  ]);
  expect(presentation.history.map(entry => entry.candidate.candidate_id)).toEqual([
    'slot-1',
    'slot-0',
  ]);
});

it('keeps a dismissed latest entry as a tombstone instead of reviving the old failed slot', () => {
  const original = job('original', '2026-08-25T00:00:00Z', [
    { candidate_id: 'slot-0', index: 0, status: 'succeeded', version_id: 'version-0', error: null },
    { candidate_id: 'slot-1', index: 1, status: 'failed', version_id: null, error: 'failed' },
  ]);
  const dismissedRetry = job('retry', '2026-08-25T00:01:00Z', [
    {
      candidate_id: 'slot-0-retry',
      index: 0,
      status: 'succeeded',
      version_id: 'version-0-retry',
      error: null,
    },
    {
      candidate_id: 'slot-1-retry',
      index: 1,
      status: 'canceled',
      version_id: null,
      error: null,
      dismissed_at: '2026-08-25T00:02:00Z',
    },
  ]);

  const presentation = presentCanvasCandidates([original, dismissedRetry]);

  expect(presentation.current.map(entry => entry.candidate.candidate_id)).toEqual(['slot-0-retry']);
  expect(presentation.history.map(entry => entry.candidate.candidate_id)).toEqual([
    'slot-1',
    'slot-0',
  ]);
});
