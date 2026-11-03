import { expect, it } from 'vitest';
import { canvasPromptPreviewSource } from './promptPreviewSource';
import type { Job } from '@/schema/jobs';
import type { CanvasContentVersion } from '@/schema/canvas';
const version: CanvasContentVersion = { version_id: 'v2', kind: 'image', path: 'outputs/job-x/second.png',
  origin: { kind: 'job_output', job_id: 'job-x', candidate_id: 'candidate-3' }, width: 300, height: 600,
  mime_type: 'image/png', bytes: 1, sha256: 'a', created_at: '' };
it('uses the registered output path instead of the candidate position, including Windows paths', () => {
  const job = { job_id: 'job-x', params: { prompt_asset_id: 'prompt-a' }, output_paths: ['C:\\data\\outputs\\job-x\\first.png', 'C:\\data\\outputs\\job-x\\second.png'] } as Job;
  expect(canvasPromptPreviewSource(version, [job])).toEqual({ jobId: 'job-x', outputIndex: 1, promptAssetId: 'prompt-a' });
  expect(canvasPromptPreviewSource(version, [{ ...job, output_paths: ['different.png'] }])).toBeNull();
  expect(canvasPromptPreviewSource(version, [])).toBeNull();
});
it('does not turn a local upload into a generated result', () => {
  expect(canvasPromptPreviewSource({ ...version, origin: { kind: 'upload', upload_id: 'u' } }, [])).toBeNull();
});
